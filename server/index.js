require('dotenv').config();

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const db = require('./db');
const ollama = require('./ollama-client');
const toolExecutor = require('./tool-executor');
const githubClient = require('./github-client');
const linearClient = require('./linear-client');

const app = express();
const PORT = parseInt(process.env.PORT || '3939', 10);

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Static files - Chat UI
app.use(express.static(path.join(__dirname, 'public')));

// In-Memory Agent-Registry
const agents = new Map();

// ===================================================
// Agent-Konfigurationen laden
// ===================================================

function loadAgents() {
  const agentDir = '/agents';
  let loaded = 0;
  let skipped = 0;

  if (!fs.existsSync(agentDir)) {
    console.warn('[Agents] Verzeichnis /agents nicht gefunden!');
    return;
  }

  const files = fs.readdirSync(agentDir).filter((f) => f.endsWith('.json'));

  for (const file of files) {
    try {
      const filePath = path.join(agentDir, file);
      const raw = fs.readFileSync(filePath, 'utf-8');
      const config = JSON.parse(raw);

      // Nur Dateien mit id und systemInstructions laden
      if (!config.id || !config.systemInstructions) {
        console.warn(`[Agents] Uebersprungen (kein id/systemInstructions): ${file}`);
        skipped++;
        continue;
      }

      agents.set(config.id, {
        id: config.id,
        name: config.name || config.id,
        description: config.description || '',
        systemInstructions: config.systemInstructions,
        modelPreferences: config.modelPreferences || {},
        lettaConfig: config.lettaConfig || {},
        frameworks: config.frameworks || [],
        knowledge: config.knowledge || {},
        version: config.version || '1.0.0',
        createdAt: config.createdAt,
        sourceFile: file,
      });

      loaded++;
    } catch (err) {
      console.error(`[Agents] Fehler beim Laden von ${file}:`, err.message);
      skipped++;
    }
  }

  console.log(`[Agents] ${loaded} Agents geladen, ${skipped} uebersprungen`);
  console.log('[Agents] Geladene Agents:');
  for (const [id, agent] of agents) {
    console.log(`  - ${id}: ${agent.name}`);
  }
}

// ===================================================
// Memory: Initiale Memory-Blocks aus Agent-Config laden
// ===================================================

async function initAgentMemory() {
  let initialized = 0;

  for (const [agentId, agent] of agents) {
    const memBlocks = agent.lettaConfig?.memoryBlocks || [];

    for (const block of memBlocks) {
      if (block.label && block.value) {
        try {
          // Nur setzen wenn noch nicht vorhanden (kein Ueberschreiben)
          const existing = await db.getAgentMemory(agentId);
          const exists = existing.some((m) => m.label === block.label);
          if (!exists) {
            await db.upsertAgentMemory(agentId, block.label, block.value);
            initialized++;
          }
        } catch {
          // Ignore - wird spaeter bei Bedarf erstellt
        }
      }
    }
  }

  if (initialized > 0) {
    console.log(`[Memory] ${initialized} initiale Memory-Blocks erstellt`);
  }
}

// ===================================================
// API Routes
// ===================================================

// --- Health Check ---
app.get('/api/health', async (req, res) => {
  try {
    const [ollamaHealth, dbHealth] = await Promise.all([
      ollama.healthCheck(),
      db.healthCheck(),
    ]);

    const healthy = ollamaHealth.connected && dbHealth.connected;

    res.status(healthy ? 200 : 503).json({
      status: healthy ? 'healthy' : 'degraded',
      uptime: process.uptime(),
      agents: {
        loaded: agents.size,
        list: Array.from(agents.keys()),
      },
      ollama: ollamaHealth,
      database: dbHealth,
    });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

// --- Alle Agents auflisten ---
app.get('/api/agents', (req, res) => {
  const agentList = Array.from(agents.values()).map((a) => ({
    id: a.id,
    name: a.name,
    description: a.description,
    version: a.version,
    frameworks: a.frameworks,
    model: a.modelPreferences?.defaultModel || 'ollama/glm-4.7',
    temperature: a.modelPreferences?.temperature,
    tools: a.lettaConfig?.allowedTools || [],
  }));

  res.json({
    count: agentList.length,
    agents: agentList,
  });
});

// --- Einzelnen Agent abrufen ---
app.get('/api/agents/:id', (req, res) => {
  const agent = agents.get(req.params.id);
  if (!agent) {
    return res.status(404).json({ error: `Agent '${req.params.id}' nicht gefunden` });
  }

  res.json({
    id: agent.id,
    name: agent.name,
    description: agent.description,
    version: agent.version,
    frameworks: agent.frameworks,
    knowledge: agent.knowledge,
    modelPreferences: agent.modelPreferences,
    lettaConfig: {
      allowedTools: agent.lettaConfig?.allowedTools || [],
      permissionMode: agent.lettaConfig?.permissionMode,
      memoryBlocks: (agent.lettaConfig?.memoryBlocks || []).map((b) => b.label),
    },
    systemInstructionsLength: agent.systemInstructions.length,
    createdAt: agent.createdAt,
  });
});

// --- Chat mit Agent ---
app.post('/api/agents/:id/chat', async (req, res) => {
  const agent = agents.get(req.params.id);
  if (!agent) {
    return res.status(404).json({ error: `Agent '${req.params.id}' nicht gefunden` });
  }

  const { message, conversationId, options, githubToken, linearApiKey } = req.body;

  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    return res.status(400).json({ error: 'Feld "message" ist erforderlich (nicht-leerer String)' });
  }

  // Tokens: aus Request-Body oder Environment
  const ghToken = githubToken || process.env.GITHUB_TOKEN || '';
  const lnKey = linearApiKey || process.env.LINEAR_API_KEY || '';

  try {
    // Conversation erstellen oder laden
    let convId = conversationId;
    let conversation;

    if (convId) {
      conversation = await db.getConversation(convId);
      if (!conversation) {
        return res.status(404).json({ error: `Conversation '${convId}' nicht gefunden` });
      }
      if (conversation.agent_id !== agent.id) {
        return res.status(400).json({
          error: `Conversation '${convId}' gehoert zu Agent '${conversation.agent_id}', nicht zu '${agent.id}'`,
        });
      }
    } else {
      // Neue Conversation erstellen
      const title = message.substring(0, 100);
      conversation = await db.createConversation(agent.id, title);
      convId = conversation.id;
    }

    // User-Nachricht speichern
    await db.addMessage(convId, 'user', message.trim());

    // Bisherigen Verlauf laden fuer Kontext
    const history = await db.getMessages(convId, 50);

    // Messages-Array fuer Ollama zusammenbauen
    const ollamaMessages = [
      { role: 'system', content: agent.systemInstructions },
      ...history.map((m) => ({ role: m.role, content: m.content })),
    ];

    const model = ollama.DEFAULT_MODEL;
    const temperature = agent.modelPreferences?.temperature ?? 0.7;

    // Tools verfuegbar? Dann mit Tool-Calling
    const availableTools = toolExecutor.getAvailableTools(ghToken, lnKey);
    let assistantMessage = '';
    let toolsUsed = [];
    let totalDuration = 0;
    let evalCount = 0;

    if (availableTools.length > 0) {
      // Chat mit Tool-Calling-Loop
      const result = await toolExecutor.chatWithTools(
        ollama.client,
        model,
        ollamaMessages,
        availableTools,
        { temperature, ...(options || {}) },
        ghToken,
        lnKey,
        10
      );
      assistantMessage = result.message;
      toolsUsed = result.toolResults || [];
      totalDuration = result.totalDuration || 0;
      evalCount = result.evalCount || 0;
    } else {
      // Ohne Tools - normaler Chat
      const ollamaResponse = await ollama.chat(model, ollamaMessages, {
        temperature,
        ...(options || {}),
      });
      assistantMessage = ollamaResponse.message?.content || '';
      totalDuration = ollamaResponse.total_duration;
      evalCount = ollamaResponse.eval_count;
    }

    // Antwort speichern
    await db.addMessage(convId, 'assistant', assistantMessage);

    res.json({
      response: assistantMessage,
      conversationId: convId,
      agent: agent.id,
      model,
      toolsUsed: toolsUsed.map((t) => ({
        name: t.tool_call_id || 'tool',
        content: typeof t.content === 'string' ? t.content.substring(0, 500) : '',
      })),
      totalDuration,
      evalCount,
    });
  } catch (err) {
    console.error(`[Chat] Fehler bei Agent ${agent.id}:`, err.message);

    if (err.message.includes('connection')) {
      return res.status(503).json({
        error: 'Ollama ist nicht erreichbar. Bitte spaeter erneut versuchen.',
        details: err.message,
      });
    }

    res.status(500).json({
      error: 'Chat-Anfrage fehlgeschlagen',
      details: err.message,
    });
  }
});

// --- Conversations eines Agents auflisten ---
app.get('/api/agents/:id/conversations', async (req, res) => {
  const agent = agents.get(req.params.id);
  if (!agent) {
    return res.status(404).json({ error: `Agent '${req.params.id}' nicht gefunden` });
  }

  try {
    const conversations = await db.listConversations(agent.id);
    res.json({
      agent: agent.id,
      count: conversations.length,
      conversations,
    });
  } catch (err) {
    res.status(500).json({ error: 'Fehler beim Laden der Conversations', details: err.message });
  }
});

// --- Conversation-Details abrufen ---
app.get('/api/conversations/:conversationId', async (req, res) => {
  try {
    const conversation = await db.getConversation(req.params.conversationId);
    if (!conversation) {
      return res.status(404).json({ error: 'Conversation nicht gefunden' });
    }
    res.json(conversation);
  } catch (err) {
    res.status(500).json({ error: 'Fehler beim Laden der Conversation', details: err.message });
  }
});

// --- Conversation loeschen ---
app.delete('/api/conversations/:conversationId', async (req, res) => {
  try {
    const deleted = await db.deleteConversation(req.params.conversationId);
    if (!deleted) {
      return res.status(404).json({ error: 'Conversation nicht gefunden' });
    }
    res.json({ deleted: true, conversationId: req.params.conversationId });
  } catch (err) {
    res.status(500).json({ error: 'Fehler beim Loeschen der Conversation', details: err.message });
  }
});

// --- Agent Memory abrufen ---
app.get('/api/agents/:id/memory', async (req, res) => {
  const agent = agents.get(req.params.id);
  if (!agent) {
    return res.status(404).json({ error: `Agent '${req.params.id}' nicht gefunden` });
  }

  try {
    const memory = await db.getAgentMemory(agent.id);
    res.json({
      agent: agent.id,
      blocks: memory.map((m) => ({
        label: m.label,
        value: m.value,
        updatedAt: m.updated_at,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: 'Fehler beim Laden der Memory', details: err.message });
  }
});

// --- Agent Memory aktualisieren ---
app.post('/api/agents/:id/memory', async (req, res) => {
  const agent = agents.get(req.params.id);
  if (!agent) {
    return res.status(404).json({ error: `Agent '${req.params.id}' nicht gefunden` });
  }

  const { label, value } = req.body;

  if (!label || typeof label !== 'string') {
    return res.status(400).json({ error: 'Feld "label" ist erforderlich (String)' });
  }
  if (!value || typeof value !== 'string') {
    return res.status(400).json({ error: 'Feld "value" ist erforderlich (String)' });
  }

  try {
    const result = await db.upsertAgentMemory(agent.id, label, value);
    res.json({
      agent: agent.id,
      label: result.label,
      value: result.value,
      updatedAt: result.updated_at,
    });
  } catch (err) {
    res.status(500).json({ error: 'Fehler beim Aktualisieren der Memory', details: err.message });
  }
});

// --- Ollama Modelle auflisten (Hilfs-Endpoint) ---
app.get('/api/models', async (req, res) => {
  try {
    const models = await ollama.listModels();
    res.json({ models });
  } catch (err) {
    res.status(503).json({ error: 'Ollama nicht erreichbar', details: err.message });
  }
});

// ===================================================
// NEW ENDPOINTS
// ===================================================

// --- SSE Streaming Chat Endpoint ---
app.post('/api/agents/:id/chat/stream', async (req, res) => {
  const agent = agents.get(req.params.id);
  if (!agent) {
    return res.status(404).json({ error: `Agent '${req.params.id}' nicht gefunden` });
  }

  const { message, conversationId, options } = req.body;

  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    return res.status(400).json({ error: 'Feld "message" ist erforderlich (nicht-leerer String)' });
  }

  try {
    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Conversation erstellen oder laden
    let convId = conversationId;
    let conversation;

    if (convId) {
      conversation = await db.getConversation(convId);
      if (!conversation) {
        res.write(`data: ${JSON.stringify({ error: `Conversation '${convId}' nicht gefunden` })}\n\n`);
        return res.end();
      }
      if (conversation.agent_id !== agent.id) {
        res.write(`data: ${JSON.stringify({ error: `Conversation '${convId}' gehoert zu Agent '${conversation.agent_id}', nicht zu '${agent.id}'` })}\n\n`);
        return res.end();
      }
    } else {
      // Neue Conversation erstellen
      const title = message.substring(0, 100);
      conversation = await db.createConversation(agent.id, title);
      convId = conversation.id;
    }

    // User-Nachricht speichern
    await db.addMessage(convId, 'user', message.trim());

    // Bisherigen Verlauf laden fuer Kontext
    const history = await db.getMessages(convId, 50);

    // Messages-Array fuer Ollama zusammenbauen
    const ollamaMessages = [
      { role: 'system', content: agent.systemInstructions },
      ...history.map((m) => ({ role: m.role, content: m.content })),
    ];

    // An Ollama senden
    const model = ollama.DEFAULT_MODEL;
    const temperature = agent.modelPreferences?.temperature ?? 0.7;

    // Check if chatStream is available
    if (typeof ollama.chatStream === 'function') {
      // Use streaming
      let fullMessage = '';

      for await (const chunk of ollama.chatStream(model, ollamaMessages, {
        temperature,
        ...(options || {}),
      })) {
        const textChunk = chunk.message?.content || '';
        fullMessage += textChunk;

        // Send chunk as SSE
        res.write(`data: ${JSON.stringify({ chunk: textChunk, done: false })}\n\n`);
      }

      // Save complete message to DB
      await db.addMessage(convId, 'assistant', fullMessage);

      // Send completion event
      res.write(`data: ${JSON.stringify({
        chunk: '',
        done: true,
        conversationId: convId,
        model: model
      })}\n\n`);
    } else {
      // Fallback: use non-streaming and send as single SSE event
      const ollamaResponse = await ollama.chat(model, ollamaMessages, {
        temperature,
        ...(options || {}),
      });

      const assistantMessage = ollamaResponse.message?.content || '';

      // Antwort speichern
      await db.addMessage(convId, 'assistant', assistantMessage);

      // Send as single chunk
      res.write(`data: ${JSON.stringify({
        chunk: assistantMessage,
        done: true,
        conversationId: convId,
        model: ollamaResponse.model || model
      })}\n\n`);
    }

    res.end();
  } catch (err) {
    console.error(`[Chat Stream] Fehler bei Agent ${agent.id}:`, err.message);

    res.write(`data: ${JSON.stringify({
      error: 'Streaming-Anfrage fehlgeschlagen',
      details: err.message
    })}\n\n`);
    res.end();
  }
});

// --- File Upload Endpoint ---
app.post('/api/agents/:id/chat/upload', async (req, res) => {
  const agent = agents.get(req.params.id);
  if (!agent) {
    return res.status(404).json({ error: `Agent '${req.params.id}' nicht gefunden` });
  }

  const { message, file, conversationId, options } = req.body;

  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    return res.status(400).json({ error: 'Feld "message" ist erforderlich (nicht-leerer String)' });
  }

  if (!file || !file.name || !file.content) {
    return res.status(400).json({ error: 'Feld "file" muss {name, content} enthalten' });
  }

  try {
    // Decode base64 if needed
    let fileContent = file.content;
    if (file.type && !file.type.startsWith('text/')) {
      try {
        fileContent = Buffer.from(file.content, 'base64').toString('utf-8');
      } catch (decodeErr) {
        // If decoding fails, use as-is (might already be plain text)
      }
    }

    // Prepend file content to message
    const enrichedMessage = `[Datei: ${file.name}]\n\`\`\`\n${fileContent}\n\`\`\`\n\nUser: ${message.trim()}`;

    // Conversation erstellen oder laden
    let convId = conversationId;
    let conversation;

    if (convId) {
      conversation = await db.getConversation(convId);
      if (!conversation) {
        return res.status(404).json({ error: `Conversation '${convId}' nicht gefunden` });
      }
      if (conversation.agent_id !== agent.id) {
        return res.status(400).json({
          error: `Conversation '${convId}' gehoert zu Agent '${conversation.agent_id}', nicht zu '${agent.id}'`,
        });
      }
    } else {
      // Neue Conversation erstellen
      const title = `${file.name}: ${message.substring(0, 80)}`;
      conversation = await db.createConversation(agent.id, title);
      convId = conversation.id;
    }

    // User-Nachricht speichern (mit Datei-Kontext)
    await db.addMessage(convId, 'user', enrichedMessage);

    // Bisherigen Verlauf laden fuer Kontext
    const history = await db.getMessages(convId, 50);

    // Messages-Array fuer Ollama zusammenbauen
    const ollamaMessages = [
      { role: 'system', content: agent.systemInstructions },
      ...history.map((m) => ({ role: m.role, content: m.content })),
    ];

    // An Ollama senden
    const model = ollama.DEFAULT_MODEL;
    const temperature = agent.modelPreferences?.temperature ?? 0.7;

    const ollamaResponse = await ollama.chat(model, ollamaMessages, {
      temperature,
      ...(options || {}),
    });

    const assistantMessage = ollamaResponse.message?.content || '';

    // Antwort speichern
    await db.addMessage(convId, 'assistant', assistantMessage);

    res.json({
      response: assistantMessage,
      conversationId: convId,
      agent: agent.id,
      model: ollamaResponse.model || model,
      file: {
        name: file.name,
        processed: true,
      },
      totalDuration: ollamaResponse.total_duration,
      evalCount: ollamaResponse.eval_count,
    });
  } catch (err) {
    console.error(`[Chat Upload] Fehler bei Agent ${agent.id}:`, err.message);

    if (err.message.includes('connection')) {
      return res.status(503).json({
        error: 'Ollama ist nicht erreichbar. Bitte spaeter erneut versuchen.',
        details: err.message,
      });
    }

    res.status(500).json({
      error: 'Chat-Anfrage mit Datei fehlgeschlagen',
      details: err.message,
    });
  }
});


// --- Settings Endpoint ---
app.post('/api/settings', (req, res) => {
  const { githubToken, linearApiKey } = req.body;
  if (githubToken !== undefined) {
    process.env.GITHUB_TOKEN = githubToken;
  }
  if (linearApiKey !== undefined) {
    process.env.LINEAR_API_KEY = linearApiKey;
  }
  res.json({ success: true });
});

// --- GitHub Proxy - List Repos (via body/query token) ---
app.get('/api/github/repos', async (req, res) => {
  const token = req.query.token || req.headers['x-github-token'] || process.env.GITHUB_TOKEN;
  if (!token) {
    return res.status(503).json({ error: 'GitHub not configured' });
  }
  const result = await githubClient.executeFunction('github_list_repos', {}, token);
  if (result.error) return res.status(500).json(result);
  const repos = (result.repos || []).map((r) => ({
    name: r.name, fullName: r.full_name, description: r.description,
    private: r.private, url: r.html_url, language: r.language, updatedAt: r.updated_at,
  }));
  res.json({ count: repos.length, repos });
});

// --- GitHub Proxy - Get File ---
app.post('/api/github/file', async (req, res) => {
  const { repo, path: filePath, token: bodyToken } = req.body;
  const token = bodyToken || process.env.GITHUB_TOKEN;
  if (!token) return res.status(503).json({ error: 'GitHub not configured' });
  if (!repo || !filePath) return res.status(400).json({ error: '"repo" and "path" required' });
  const result = await githubClient.executeFunction('github_get_file', { repo, path: filePath }, token);
  if (result.error) return res.status(result.error.includes('not found') ? 404 : 500).json(result);
  res.json(result);
});

// --- GitHub Proxy - List Files (for tree browser) ---
app.post('/api/github/files', async (req, res) => {
  const { repo, path: dirPath, token: bodyToken } = req.body;
  const token = bodyToken || process.env.GITHUB_TOKEN;
  if (!token) return res.status(503).json({ error: 'GitHub not configured' });
  if (!repo) return res.status(400).json({ error: '"repo" required' });
  const result = await githubClient.executeFunction('github_list_files', { repo, path: dirPath || '' }, token);
  if (result.error) return res.status(500).json(result);
  res.json(result);
});

// --- GitHub Proxy - List Issues ---
app.get('/api/github/issues/:repo(*)', async (req, res) => {
  const token = req.query.token || process.env.GITHUB_TOKEN;
  if (!token) return res.status(503).json({ error: 'GitHub not configured' });
  const result = await githubClient.executeFunction('github_list_issues', { repo: req.params.repo, state: req.query.state || 'open' }, token);
  if (result.error) return res.status(500).json(result);
  res.json(result);
});

// --- GitHub Test Connection ---
app.post('/api/github/test', async (req, res) => {
  const token = req.body.token || process.env.GITHUB_TOKEN;
  if (!token) return res.status(400).json({ error: 'No token provided' });
  const result = await githubClient.executeFunction('github_list_repos', {}, token);
  if (result.error) return res.status(401).json({ connected: false, error: result.error });
  res.json({ connected: true, repos: (result.repos || []).length });
});

// --- Linear Proxy - List Teams ---
app.post('/api/linear/teams', async (req, res) => {
  const apiKey = req.body.apiKey || process.env.LINEAR_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'Linear not configured' });
  const result = await linearClient.executeFunction('linear_list_teams', {}, apiKey);
  if (result.error) return res.status(500).json(result);
  res.json(result);
});

// --- Linear Proxy - List Issues ---
app.post('/api/linear/issues', async (req, res) => {
  const apiKey = req.body.apiKey || process.env.LINEAR_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'Linear not configured' });
  const result = await linearClient.executeFunction('linear_list_issues', {
    teamId: req.body.teamId, state: req.body.state, limit: req.body.limit || 50,
  }, apiKey);
  if (result.error) return res.status(500).json(result);
  res.json(result);
});

// --- Linear Proxy - Search Issues ---
app.post('/api/linear/search', async (req, res) => {
  const apiKey = req.body.apiKey || process.env.LINEAR_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'Linear not configured' });
  const result = await linearClient.executeFunction('linear_search_issues', { query: req.body.query }, apiKey);
  if (result.error) return res.status(500).json(result);
  res.json(result);
});

// --- Linear Test Connection ---
app.post('/api/linear/test', async (req, res) => {
  const apiKey = req.body.apiKey || process.env.LINEAR_API_KEY;
  if (!apiKey) return res.status(400).json({ error: 'No API key provided' });
  const result = await linearClient.executeFunction('linear_list_teams', {}, apiKey);
  if (result.error) return res.status(401).json({ connected: false, error: result.error });
  res.json({ connected: true, teams: Array.isArray(result) ? result.length : 0 });
});

// --- 404 Handler ---
app.use((req, res) => {
  res.status(404).json({
    error: 'Endpoint nicht gefunden',
    availableEndpoints: [
      'GET  /api/health',
      'GET  /api/agents',
      'GET  /api/agents/:id',
      'POST /api/agents/:id/chat',
      'POST /api/agents/:id/chat/stream',
      'POST /api/agents/:id/chat/upload',
      'GET  /api/agents/:id/conversations',
      'GET  /api/agents/:id/memory',
      'POST /api/agents/:id/memory',
      'GET  /api/conversations/:id',
      'DELETE /api/conversations/:id',
      'GET  /api/models',
      'GET  /api/github/repos',
      'POST /api/github/file',
    ],
  });
});

// --- Error Handler ---
app.use((err, req, res, _next) => {
  console.error('[Server] Unbehandelter Fehler:', err);
  res.status(500).json({ error: 'Interner Server-Fehler', details: err.message });
});

// ===================================================
// Server starten
// ===================================================

async function start() {
  console.log('');
  console.log('=============================================');
  console.log('  Letta Agent Server v1.0.0');
  console.log('=============================================');
  console.log('');

  // 1. Agent-Konfigurationen laden
  console.log('[Startup] Lade Agent-Konfigurationen ...');
  loadAgents();
  console.log('');

  // 2. Datenbank initialisieren
  console.log('[Startup] Initialisiere Datenbank ...');
  try {
    await db.initDatabase();
  } catch (err) {
    console.error('[Startup] Datenbank-Initialisierung fehlgeschlagen:', err.message);
    console.error('[Startup] Server startet trotzdem (Datenbank wird spaeter erneut versucht)');
  }
  console.log('');

  // 3. Initiale Memory-Blocks setzen
  console.log('[Startup] Initialisiere Agent-Memory ...');
  try {
    await initAgentMemory();
  } catch (err) {
    console.warn('[Startup] Memory-Initialisierung teilweise fehlgeschlagen:', err.message);
  }
  console.log('');

  // 4. Ollama-Verbindung pruefen
  console.log('[Startup] Pruefe Ollama-Verbindung ...');
  const ollamaHealth = await ollama.healthCheck();
  if (ollamaHealth.connected) {
    console.log(`[Startup] Ollama verbunden - ${ollamaHealth.models} Modell(e) verfuegbar`);
    if (ollamaHealth.hasGlm4) {
      console.log(`[Startup] GLM-4 Modell (${ollama.DEFAULT_MODEL}) ist bereit!`);
    } else {
      console.warn(`[Startup] WARNUNG: GLM-4 Modell (${ollama.DEFAULT_MODEL}) nicht gefunden!`);
      console.warn('[Startup] Verfuegbare Modelle:', ollamaHealth.modelList?.join(', ') || 'keine');
      console.warn('[Startup] Bitte manuell ausfuehren: docker exec ollama-glm4 ollama pull glm4');
    }
  } else {
    console.warn('[Startup] WARNUNG: Ollama nicht erreichbar!');
    console.warn('[Startup] Chat-Anfragen werden fehlschlagen bis Ollama bereit ist.');
  }
  console.log('');

  // 5. HTTP-Server starten
  app.listen(PORT, '0.0.0.0', () => {
    console.log('=============================================');
    console.log(`  Server laeuft auf Port ${PORT}`);
    console.log(`  ${agents.size} Agents geladen`);
    console.log(`  Ollama: ${ollamaHealth.connected ? 'verbunden' : 'NICHT verbunden'}`);
    console.log(`  Modell: ${ollama.DEFAULT_MODEL}`);
    console.log('=============================================');
    console.log('');
    console.log('API Endpoints:');
    console.log(`  GET  http://localhost:${PORT}/api/health`);
    console.log(`  GET  http://localhost:${PORT}/api/agents`);
    console.log(`  GET  http://localhost:${PORT}/api/agents/:id`);
    console.log(`  POST http://localhost:${PORT}/api/agents/:id/chat`);
    console.log(`  POST http://localhost:${PORT}/api/agents/:id/chat/stream`);
    console.log(`  POST http://localhost:${PORT}/api/agents/:id/chat/upload`);
    console.log(`  GET  http://localhost:${PORT}/api/agents/:id/conversations`);
    console.log(`  GET  http://localhost:${PORT}/api/agents/:id/memory`);
    console.log(`  POST http://localhost:${PORT}/api/agents/:id/memory`);
    console.log(`  GET  http://localhost:${PORT}/api/conversations/:id`);
    console.log(`  DEL  http://localhost:${PORT}/api/conversations/:id`);
    console.log(`  GET  http://localhost:${PORT}/api/models`);
    console.log(`  GET  http://localhost:${PORT}/api/github/repos`);
    console.log(`  POST http://localhost:${PORT}/api/github/file`);
    console.log('');
  });
}

// Graceful Shutdown
process.on('SIGTERM', () => {
  console.log('[Server] SIGTERM empfangen, fahre herunter ...');
  db.pool.end();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('[Server] SIGINT empfangen, fahre herunter ...');
  db.pool.end();
  process.exit(0);
});

process.on('unhandledRejection', (reason) => {
  console.error('[Server] Unhandled Rejection:', reason);
});

// Server starten
start().catch((err) => {
  console.error('[FATAL] Server-Start fehlgeschlagen:', err);
  process.exit(1);
});
