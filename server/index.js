require('dotenv').config();

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const db = require('./db');
const ollama = require('./ollama-client');

const app = express();
const PORT = parseInt(process.env.PORT || '3939', 10);

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));

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

  const { message, conversationId, options } = req.body;

  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    return res.status(400).json({ error: 'Feld "message" ist erforderlich (nicht-leerer String)' });
  }

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
      totalDuration: ollamaResponse.total_duration,
      evalCount: ollamaResponse.eval_count,
    });
  } catch (err) {
    console.error(`[Chat] Fehler bei Agent ${agent.id}:`, err.message);

    // Benutzerfreundliche Fehlermeldungen
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

// --- 404 Handler ---
app.use((req, res) => {
  res.status(404).json({
    error: 'Endpoint nicht gefunden',
    availableEndpoints: [
      'GET  /api/health',
      'GET  /api/agents',
      'GET  /api/agents/:id',
      'POST /api/agents/:id/chat',
      'GET  /api/agents/:id/conversations',
      'GET  /api/agents/:id/memory',
      'POST /api/agents/:id/memory',
      'GET  /api/conversations/:id',
      'DELETE /api/conversations/:id',
      'GET  /api/models',
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
    console.log(`  GET  http://localhost:${PORT}/api/agents/:id/conversations`);
    console.log(`  GET  http://localhost:${PORT}/api/agents/:id/memory`);
    console.log(`  POST http://localhost:${PORT}/api/agents/:id/memory`);
    console.log(`  GET  http://localhost:${PORT}/api/conversations/:id`);
    console.log(`  DEL  http://localhost:${PORT}/api/conversations/:id`);
    console.log(`  GET  http://localhost:${PORT}/api/models`);
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
