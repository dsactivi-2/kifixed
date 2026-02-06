const axios = require('axios');

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'https://api.ollama.com';
const OLLAMA_API_KEY = process.env.OLLAMA_API_KEY || '';
const DEFAULT_MODEL = process.env.OLLAMA_MODEL || 'glm4';

// Headers mit API Key (Bearer Auth fuer Ollama Cloud)
const headers = { 'Content-Type': 'application/json' };
if (OLLAMA_API_KEY) {
  headers['Authorization'] = `Bearer ${OLLAMA_API_KEY}`;
}

// Axios-Instanz mit erhoehtem Timeout (LLM-Antworten dauern)
const client = axios.create({
  baseURL: OLLAMA_HOST,
  timeout: 300000, // 5 Minuten Timeout fuer lange Antworten
  headers,
});

/**
 * Chat-Completion ueber Ollama Cloud API.
 * Sendet Nachrichten-Array und gibt die Antwort zurueck.
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
 * Pruefen ob ein bestimmtes Modell verfuegbar ist.
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
 * Health-Check: Ist Ollama Cloud erreichbar?
 */
async function healthCheck() {
  try {
    const models = await listModels();
    const hasGlm4 = models.some(
      (m) => m.name === DEFAULT_MODEL || m.name === `${DEFAULT_MODEL}:latest`
    );
    return {
      connected: true,
      cloud: true,
      host: OLLAMA_HOST,
      models: models.length,
      hasGlm4,
      modelList: models.map((m) => m.name),
    };
  } catch (err) {
    return { connected: false, cloud: true, host: OLLAMA_HOST, error: err.message, models: 0, hasGlm4: false };
  }
}

/**
 * Warte bis Ollama Cloud erreichbar ist (retry mit backoff).
 */
async function waitForOllama(maxRetries = 15, initialDelay = 3000) {
  let delay = initialDelay;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await client.get('/api/tags');
      console.log(`[Ollama Cloud] Verbindung hergestellt (Versuch ${attempt})`);
      return true;
    } catch {
      console.log(
        `[Ollama Cloud] Warte auf ${OLLAMA_HOST}... (Versuch ${attempt}/${maxRetries})`
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 1.5, 15000);
    }
  }

  console.error('[Ollama Cloud] Konnte keine Verbindung herstellen!');
  return false;
}

/**
 * Chat-Completion mit Streaming ueber Ollama Cloud API.
 * Gibt einen Stream zurueck, der einzelne Text-Chunks liefert.
 * @returns {Promise<{stream: ReadableStream, abort: Function}>}
 */
async function chatStream(model, messages, options = {}) {
  const payload = {
    model: model || DEFAULT_MODEL,
    messages,
    stream: true,
    options: {
      temperature: options.temperature ?? 0.7,
      num_predict: options.maxTokens ?? 4096,
      top_p: options.topP ?? 0.9,
      ...(options.ollamaOptions || {}),
    },
  };

  const controller = new AbortController();
  const fetchHeaders = { 'Content-Type': 'application/json' };
  if (OLLAMA_API_KEY) {
    fetchHeaders['Authorization'] = `Bearer ${OLLAMA_API_KEY}`;
  }

  try {
    const response = await fetch(`${OLLAMA_HOST}/api/chat`, {
      method: 'POST',
      headers: fetchHeaders,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Ollama stream error (${response.status}): ${errorText}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    const stream = new ReadableStream({
      async start(streamController) {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value, { stream: true });
            const lines = chunk.split('\n').filter(line => line.trim());

            for (const line of lines) {
              try {
                const json = JSON.parse(line);
                if (json.message?.content) {
                  streamController.enqueue(json.message.content);
                }
              } catch (e) {
                // Ignoriere ungueltige JSON-Zeilen
              }
            }
          }
          streamController.close();
        } catch (error) {
          streamController.error(error);
        }
      },
    });

    return {
      stream,
      abort: () => controller.abort(),
    };
  } catch (err) {
    throw new Error(`Ollama stream connection error: ${err.message}`);
  }
}

module.exports = {
  chat,
  chatStream,
  listModels,
  isModelAvailable,
  healthCheck,
  waitForOllama,
  DEFAULT_MODEL,
  client,
};
