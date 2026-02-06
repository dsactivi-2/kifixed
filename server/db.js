const { Pool } = require('pg');

// PostgreSQL Connection Pool
const pool = new Pool({
  host: process.env.POSTGRES_HOST || 'localhost',
  port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
  user: process.env.POSTGRES_USER || 'agents',
  password: process.env.POSTGRES_PASSWORD || 'agents123',
  database: process.env.POSTGRES_DB || 'agent_db',
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

/**
 * Tabellen automatisch erstellen falls nicht vorhanden.
 * Wird beim Server-Start aufgerufen.
 */
async function initDatabase() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // UUID Extension aktivieren
    await client.query(`
      CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
    `);

    // Conversations-Tabelle
    await client.query(`
      CREATE TABLE IF NOT EXISTS conversations (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        agent_id VARCHAR(128) NOT NULL,
        title VARCHAR(512),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `);

    // Messages-Tabelle
    await client.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role VARCHAR(32) NOT NULL CHECK (role IN ('system', 'user', 'assistant')),
        content TEXT NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `);

    // Agent Memory-Tabelle
    await client.query(`
      CREATE TABLE IF NOT EXISTS agent_memory (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        agent_id VARCHAR(128) NOT NULL,
        label VARCHAR(128) NOT NULL,
        value TEXT NOT NULL,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        UNIQUE(agent_id, label)
      );
    `);

    // Indizes fuer Performance
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_conversations_agent_id ON conversations(agent_id);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_agent_memory_agent_id ON agent_memory(agent_id);
    `);

    await client.query('COMMIT');
    console.log('[DB] Tabellen erfolgreich initialisiert');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[DB] Fehler bei Tabellen-Initialisierung:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

// --- Conversation Queries ---

async function createConversation(agentId, title) {
  const result = await pool.query(
    `INSERT INTO conversations (agent_id, title) VALUES ($1, $2) RETURNING *`,
    [agentId, title || null]
  );
  return result.rows[0];
}

async function getConversation(conversationId) {
  const convResult = await pool.query(
    `SELECT * FROM conversations WHERE id = $1`,
    [conversationId]
  );
  if (convResult.rows.length === 0) return null;

  const msgResult = await pool.query(
    `SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC`,
    [conversationId]
  );

  return {
    ...convResult.rows[0],
    messages: msgResult.rows,
  };
}

async function listConversations(agentId) {
  const result = await pool.query(
    `SELECT c.*,
            (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count,
            (SELECT m.content FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_message
     FROM conversations c
     WHERE c.agent_id = $1
     ORDER BY c.updated_at DESC`,
    [agentId]
  );
  return result.rows;
}

async function deleteConversation(conversationId) {
  const result = await pool.query(
    `DELETE FROM conversations WHERE id = $1 RETURNING id`,
    [conversationId]
  );
  return result.rows.length > 0;
}

async function updateConversationTimestamp(conversationId) {
  await pool.query(
    `UPDATE conversations SET updated_at = NOW() WHERE id = $1`,
    [conversationId]
  );
}

// --- Message Queries ---

async function addMessage(conversationId, role, content) {
  const result = await pool.query(
    `INSERT INTO messages (conversation_id, role, content) VALUES ($1, $2, $3) RETURNING *`,
    [conversationId, role, content]
  );
  await updateConversationTimestamp(conversationId);
  return result.rows[0];
}

async function getMessages(conversationId, limit = 100) {
  const result = await pool.query(
    `SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC LIMIT $2`,
    [conversationId, limit]
  );
  return result.rows;
}

// --- Agent Memory Queries ---

async function getAgentMemory(agentId) {
  const result = await pool.query(
    `SELECT * FROM agent_memory WHERE agent_id = $1 ORDER BY label ASC`,
    [agentId]
  );
  return result.rows;
}

async function upsertAgentMemory(agentId, label, value) {
  const result = await pool.query(
    `INSERT INTO agent_memory (agent_id, label, value)
     VALUES ($1, $2, $3)
     ON CONFLICT (agent_id, label)
     DO UPDATE SET value = $3, updated_at = NOW()
     RETURNING *`,
    [agentId, label, value]
  );
  return result.rows[0];
}

async function deleteAgentMemory(agentId, label) {
  const result = await pool.query(
    `DELETE FROM agent_memory WHERE agent_id = $1 AND label = $2 RETURNING id`,
    [agentId, label]
  );
  return result.rows.length > 0;
}

// --- Health Check ---

async function healthCheck() {
  try {
    const result = await pool.query('SELECT NOW()');
    return { connected: true, timestamp: result.rows[0].now };
  } catch (err) {
    return { connected: false, error: err.message };
  }
}

module.exports = {
  pool,
  initDatabase,
  createConversation,
  getConversation,
  listConversations,
  deleteConversation,
  addMessage,
  getMessages,
  getAgentMemory,
  upsertAgentMemory,
  deleteAgentMemory,
  healthCheck,
};
