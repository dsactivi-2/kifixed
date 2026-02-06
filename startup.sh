#!/bin/bash
set -e

echo "============================================="
echo "  Letta Agent Server - Startup (Cloud Mode)"
echo "============================================="
echo ""

# -------------------------------------------
# 1. Warte auf PostgreSQL
# -------------------------------------------
echo "[1/3] Warte auf PostgreSQL (${POSTGRES_HOST}:${POSTGRES_PORT}) ..."
MAX_PG=30
PG_COUNT=0
until pg_isready -h "${POSTGRES_HOST}" -p "${POSTGRES_PORT}" -U "${POSTGRES_USER}" -q 2>/dev/null; do
  PG_COUNT=$((PG_COUNT + 1))
  if [ $PG_COUNT -ge $MAX_PG ]; then
    echo "[FEHLER] PostgreSQL nicht erreichbar nach ${MAX_PG} Versuchen!"
    exit 1
  fi
  echo "  PostgreSQL nicht bereit... (${PG_COUNT}/${MAX_PG})"
  sleep 2
done
echo "[OK] PostgreSQL ist bereit!"
echo ""

# -------------------------------------------
# 2. Teste Ollama Cloud Verbindung
# -------------------------------------------
echo "[2/3] Teste Ollama Cloud Verbindung (${OLLAMA_HOST}) ..."
MAX_OLLAMA=10
OLLAMA_COUNT=0
until curl -sf -H "Authorization: Bearer ${OLLAMA_API_KEY}" "${OLLAMA_HOST}/api/tags" > /dev/null 2>&1; do
  OLLAMA_COUNT=$((OLLAMA_COUNT + 1))
  if [ $OLLAMA_COUNT -ge $MAX_OLLAMA ]; then
    echo "[WARNUNG] Ollama Cloud nicht erreichbar - Server startet trotzdem"
    echo "  Chat-Anfragen werden fehlschlagen bis Cloud verfuegbar ist"
    break
  fi
  echo "  Ollama Cloud nicht erreichbar... (${OLLAMA_COUNT}/${MAX_OLLAMA})"
  sleep 3
done

if [ $OLLAMA_COUNT -lt $MAX_OLLAMA ]; then
  echo "[OK] Ollama Cloud ist erreichbar!"
fi
echo ""

# -------------------------------------------
# 3. Starte Node.js Server
# -------------------------------------------
echo "[3/3] Starte Agent Server auf Port ${PORT:-3939} ..."
echo "  Mode: Cloud (${OLLAMA_HOST})"
echo "  Model: ${OLLAMA_MODEL:-glm4}"
echo "  Agents: /agents/*.json"
echo ""
echo "============================================="
echo "  Server laeuft: http://localhost:${PORT:-3939}"
echo "============================================="
echo ""

exec node index.js
