#!/bin/bash
# ===================================================
# Startup-Script fuer den Agent Server
# Wartet auf Ollama + PostgreSQL, zieht das Modell,
# startet dann den Node.js Server.
# ===================================================

set -e

OLLAMA_HOST="${OLLAMA_HOST:-http://ollama:11434}"
OLLAMA_MODEL="${OLLAMA_MODEL:-glm4}"
POSTGRES_HOST="${POSTGRES_HOST:-postgres}"
POSTGRES_PORT="${POSTGRES_PORT:-5432}"
POSTGRES_USER="${POSTGRES_USER:-agents}"
POSTGRES_DB="${POSTGRES_DB:-agent_db}"

echo "============================================="
echo "  Letta Agent Server - Startup"
echo "============================================="
echo ""

# --- Schritt 1: Warte auf Ollama ---
echo "[1/4] Warte auf Ollama ($OLLAMA_HOST) ..."
MAX_RETRIES=60
RETRY_COUNT=0
until curl -sf "$OLLAMA_HOST/api/tags" > /dev/null 2>&1; do
  RETRY_COUNT=$((RETRY_COUNT + 1))
  if [ "$RETRY_COUNT" -ge "$MAX_RETRIES" ]; then
    echo "[FEHLER] Ollama nicht erreichbar nach $MAX_RETRIES Versuchen!"
    exit 1
  fi
  echo "  Ollama noch nicht bereit... (Versuch $RETRY_COUNT/$MAX_RETRIES)"
  sleep 3
done
echo "[OK] Ollama ist bereit!"
echo ""

# --- Schritt 2: GLM-4 Modell laden ---
echo "[2/4] Pruefe ob Modell '$OLLAMA_MODEL' vorhanden ist ..."
if curl -sf "$OLLAMA_HOST/api/tags" | grep -q "\"$OLLAMA_MODEL"; then
  echo "[OK] Modell '$OLLAMA_MODEL' bereits vorhanden."
else
  echo "  Modell '$OLLAMA_MODEL' wird heruntergeladen (kann dauern) ..."
  curl -sf "$OLLAMA_HOST/api/pull" -d "{\"name\": \"$OLLAMA_MODEL\", \"stream\": false}" \
    --max-time 3600 || {
    echo "[WARNUNG] Modell-Download fehlgeschlagen. Server startet trotzdem."
    echo "  Bitte manuell ausfuehren: docker exec ollama-glm4 ollama pull $OLLAMA_MODEL"
  }
  echo "[OK] Modell '$OLLAMA_MODEL' geladen."
fi
echo ""

# --- Schritt 3: Warte auf PostgreSQL ---
echo "[3/4] Warte auf PostgreSQL ($POSTGRES_HOST:$POSTGRES_PORT) ..."
MAX_RETRIES=30
RETRY_COUNT=0
until nc -z "$POSTGRES_HOST" "$POSTGRES_PORT" 2>/dev/null; do
  RETRY_COUNT=$((RETRY_COUNT + 1))
  if [ "$RETRY_COUNT" -ge "$MAX_RETRIES" ]; then
    echo "[FEHLER] PostgreSQL nicht erreichbar nach $MAX_RETRIES Versuchen!"
    exit 1
  fi
  echo "  PostgreSQL noch nicht bereit... (Versuch $RETRY_COUNT/$MAX_RETRIES)"
  sleep 2
done
# Kurz warten bis PostgreSQL Verbindungen akzeptiert
sleep 2
echo "[OK] PostgreSQL ist bereit!"
echo ""

# --- Schritt 4: Node.js Server starten ---
echo "[4/4] Starte Agent Server auf Port ${PORT:-3939} ..."
echo "============================================="
echo ""
exec node index.js
