const axios = require('axios');

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';
const DEFAULT_MODEL = process.env.OLLAMA_MODEL || 'glm4';

// Axios-Instanz mit erhoehtem Timeout (LLM-Antworten dauern)
const client = axios.create({
  baseURL: OLLAMA_HOST,
  timeout: 300000, // 5 Minuten Timeout fuer lange Antworten
  headers: { 'Content-Type': 'application/json' },
});

/**
 * Chat-Completion ueber Ollama API.
 * Sendet Nachrichten-Array und gibt die Antwort zurueck.
 *
 * @param {string} model - Modell-Name (z.B. "glm4")
 * @param {Array<{role: string, content: string}>} messages - Chat-Verlauf
 * @param {Object} options - Zusaetzliche Optionen (temperature, etc.)
 * @returns {Promise<{message: {role: string, content: string}, model: string, total_duration: number}>}
 */
async function chat(model, messages, options = {}) {
  const payload = {
    model: model || DEFAULT_MODEL,
    messages,
    stream: false,
    options: {
      temperature: options.temperature ?? 0.7,
      num_predict: options.maxTokens ?? 4096,
      top_p: options.topP ?? 0.9,
      ...(options.ollamaOptions || {}),
    },
  };

  try {
    const response = await client.post('/api/chat', payload);
    return response.data;
  } catch (err) {
    if (err.response) {
      const msg = err.response.data?.error || err.response.statusText;
      throw new Error(`Ollama chat error (${err.response.status}): ${msg}`);
    }
    throw new Error(`Ollama connection error: ${err.message}`);
  }
}

/**
 * Verfuegbare Modelle auflisten.
 * @returns {Promise<Array<{name: string, size: number, modified_at: string}>>}
 */
async function listModels() {
  try {
    const response = await client.get('/api/tags');
    return response.data.models || [];
  } catch (err) {
    throw new Error(`Ollama listModels error: ${err.message}`);
  }
}

/**
 * Modell herunterladen/aktualisieren.
 * @param {string} name - Modell-Name (z.B. "glm4")
 * @returns {Promise<void>}
 */
async function pullModel(name) {
  try {
    console.log(`[Ollama] Pulling model: ${name} ...`);
    const response = await client.post(
      '/api/pull',
      { name, stream: false },
      { timeout: 3600000 } // 1 Stunde fuer grosse Modelle
    );
    console.log(`[Ollama] Model ${name} pull complete`);
    return response.data;
  } catch (err) {
    throw new Error(`Ollama pullModel error: ${err.message}`);
  }
}

/**
 * Pruefen ob ein bestimmtes Modell verfuegbar ist.
 * @param {string} modelName - Modell-Name
 * @returns {Promise<boolean>}
 */
async function isModelAvailable(modelName) {
  try {
    const models = await listModels();
    return models.some(
      (m) => m.name === modelName || m.name === `${modelName}:latest`
    );
  } catch {
    return false;
  }
}

/**
 * Health-Check: Ist Ollama erreichbar?
 * @returns {Promise<{connected: boolean, models: number, hasGlm4: boolean}>}
 */
async function healthCheck() {
  try {
    const models = await listModels();
    const hasGlm4 = models.some(
      (m) => m.name === DEFAULT_MODEL || m.name === `${DEFAULT_MODEL}:latest`
    );
    return {
      connected: true,
      models: models.length,
      hasGlm4,
      modelList: models.map((m) => m.name),
    };
  } catch (err) {
    return { connected: false, error: err.message, models: 0, hasGlm4: false };
  }
}

/**
 * Warte bis Ollama bereit ist (retry mit exponential backoff).
 * @param {number} maxRetries - Maximale Versuche
 * @param {number} initialDelay - Start-Wartezeit in ms
 * @returns {Promise<boolean>}
 */
async function waitForOllama(maxRetries = 30, initialDelay = 2000) {
  let delay = initialDelay;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await client.get('/api/tags');
      console.log(`[Ollama] Verbindung hergestellt (Versuch ${attempt})`);
      return true;
    } catch {
      console.log(
        `[Ollama] Warte auf Ollama... (Versuch ${attempt}/${maxRetries})`
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 1.5, 15000); // Max 15s zwischen Versuchen
    }
  }

  console.error('[Ollama] Konnte keine Verbindung herstellen!');
  return false;
}

module.exports = {
  chat,
  listModels,
  pullModel,
  isModelAvailable,
  healthCheck,
  waitForOllama,
  DEFAULT_MODEL,
};
