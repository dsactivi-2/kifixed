FROM node:20-alpine

# Arbeitsverzeichnis setzen
WORKDIR /app

# curl fuer Health-Checks installieren
RUN apk add --no-cache curl bash

# Package-Dateien kopieren und Dependencies installieren
COPY server/package.json server/package-lock.json* ./
RUN npm ci --omit=dev 2>/dev/null || npm install --omit=dev

# Server-Code kopieren
COPY server/ ./

# Startup-Script kopieren und ausfuehrbar machen
COPY startup.sh /startup.sh
RUN chmod +x /startup.sh

# Agent-Config-Verzeichnis erstellen (wird per Volume gemounted)
RUN mkdir -p /agents

EXPOSE 3939

# Health-Check fuer den Container
HEALTHCHECK --interval=30s --timeout=10s --retries=3 --start-period=60s \
  CMD curl -sf http://localhost:3939/api/health || exit 1

CMD ["/startup.sh"]
