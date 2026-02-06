# Letta Agent Server - 26 Agents mit Ollama GLM-4

API-Server fuer 26 spezialisierte KI-Agents, betrieben mit Ollama und dem GLM-4 Modell.

## Voraussetzungen

- **Docker** (v20.10+) und **Docker Compose** (v2.0+)
- Mindestens **16 GB RAM** (GLM-4 benoetigt ca. 8-10 GB)
- Mindestens **20 GB freier Speicherplatz** (fuer das Modell)
- Optional: NVIDIA GPU mit CUDA-Treibern fuer schnellere Inferenz

## Schnellstart

```bash
# 1. Alle Services starten
docker compose up -d

# 2. Logs beobachten (erster Start laedt das GLM-4 Modell herunter)
docker compose logs -f agent-server

# 3. Health-Check
curl http://localhost:3939/api/health
```

Der erste Start dauert laenger, da das GLM-4 Modell heruntergeladen wird (~5-10 GB).

## GPU-Unterstuetzung aktivieren

In `docker-compose.yml` den GPU-Block beim Ollama-Service einkommentieren:

```yaml
deploy:
  resources:
    reservations:
      devices:
        - driver: nvidia
          count: all
          capabilities: [gpu]
```

## API Endpoints

| Methode | Endpoint | Beschreibung |
|---------|----------|-------------|
| `GET` | `/api/health` | Health-Check (Ollama, DB, Agents) |
| `GET` | `/api/agents` | Alle 26 Agents auflisten |
| `GET` | `/api/agents/:id` | Agent-Details abrufen |
| `POST` | `/api/agents/:id/chat` | Nachricht an Agent senden |
| `GET` | `/api/agents/:id/conversations` | Conversations eines Agents |
| `GET` | `/api/agents/:id/memory` | Agent Memory-Blocks abrufen |
| `POST` | `/api/agents/:id/memory` | Agent Memory aktualisieren |
| `GET` | `/api/conversations/:id` | Conversation-Verlauf |
| `DELETE` | `/api/conversations/:id` | Conversation loeschen |
| `GET` | `/api/models` | Verfuegbare Ollama-Modelle |

## Beispiel: curl-Befehle

### Alle Agents auflisten

```bash
curl http://localhost:3939/api/agents | jq
```

### Mit einem Agent chatten

```bash
curl -X POST http://localhost:3939/api/agents/meta-code/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "Erklaere mir das Strategy Pattern in TypeScript"}'
```

### Conversation fortsetzen

```bash
curl -X POST http://localhost:3939/api/agents/meta-code/chat \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Zeig mir ein konkretes Beispiel",
    "conversationId": "CONVERSATION-ID-HIER"
  }'
```

### Conversations eines Agents anzeigen

```bash
curl http://localhost:3939/api/agents/meta-code/conversations | jq
```

### Agent Memory lesen

```bash
curl http://localhost:3939/api/agents/meta-wingman/memory | jq
```

### Agent Memory aktualisieren

```bash
curl -X POST http://localhost:3939/api/agents/meta-wingman/memory \
  -H "Content-Type: application/json" \
  -d '{"label": "human", "value": "Bevorzugt kurze Antworten auf Deutsch."}'
```

### Conversation loeschen

```bash
curl -X DELETE http://localhost:3939/api/conversations/CONVERSATION-ID
```

## Verfuegbare Agents (26)

### Standard Agents
| ID | Name | Beschreibung |
|----|------|-------------|
| `meta-automation` | Meta Automation | Workflow & Process Automation |
| `meta-berater` | Meta Berater | Business Consulting (Generalist) |
| `meta-business` | Meta Business | Strategy & Business Development |
| `meta-code` | Meta Code | Code Review, Refactoring, Testing |
| `meta-data-ml` | Meta Data/ML | Data Science & Machine Learning |
| `meta-devops` | Meta DevOps | Infrastructure & Deployment |
| `meta-finance` | Meta Finance | Financial Analysis & Accounting |
| `meta-hr` | Meta HR | Recruiting & HR Processes |
| `meta-marketing` | Meta Marketing | Content, SEO, Campaigns |
| `meta-onboarding` | Meta Onboarding | Employee/Customer Onboarding |
| `meta-repo` | Meta Repo | Git Operations & CI/CD |
| `meta-security` | Meta Security | Security Audits & Compliance |
| `meta-workflow` | Meta Workflow | Workflow Design & Optimization |

### Call Center Agents
| ID | Name | Beschreibung |
|----|------|-------------|
| `meta-call-sales` | Meta Call Sales | Outbound Sales Calls |
| `meta-call-inbound` | Meta Call Inbound | Inbound Support Calls |
| `meta-call-mvp` | Meta Call MVP | Voice Call Orchestrator |
| `meta-call-campaigns` | Meta Call Campaigns | Outbound Campaigns |
| `meta-call-qa` | Meta Call QA | Call Quality Analysis |
| `meta-call-after-call` | Meta Call After-Call | Post-Call Automation |
| `meta-qa-upgrade-pipeline` | Meta QA Pipeline | Prompt Upgrade Pipeline |

### Meta Agents
| ID | Name | Beschreibung |
|----|------|-------------|
| `meta-tech` | Meta Tech | Server Monitoring & Optimization |
| `meta-prof` | Meta Prof | AI Model Research & Testing |
| `meta-builder` | Meta Builder | Agent Factory |

### Helper Agents
| ID | Name | Beschreibung |
|----|------|-------------|
| `meta-wingman` | Wingman | Agent Selection (Orchestrator) |
| `meta-winggirl` | Winggirl | Agent Selection (Alternative) |

## Administration

### Services stoppen

```bash
docker compose down
```

### Services stoppen und Daten loeschen

```bash
docker compose down -v
```

### Nur den Server neu starten (ohne Ollama/DB)

```bash
docker compose restart agent-server
```

### Logs anzeigen

```bash
# Alle Services
docker compose logs -f

# Nur Agent-Server
docker compose logs -f agent-server

# Nur Ollama
docker compose logs -f ollama
```

### GLM-4 Modell manuell laden

```bash
docker exec ollama-glm4 ollama pull glm4
```

### In den Ollama-Container wechseln

```bash
docker exec -it ollama-glm4 bash
```

## Fehlerbehebung

### "Ollama nicht erreichbar"
- Pruefen ob der Container laeuft: `docker compose ps`
- Ollama-Logs pruefen: `docker compose logs ollama`
- Health-Check: `curl http://localhost:11434/api/tags`

### "Modell nicht gefunden"
- Modell manuell laden: `docker exec ollama-glm4 ollama pull glm4`
- Verfuegbare Modelle pruefen: `curl http://localhost:3939/api/models`

### "Datenbank-Verbindung fehlgeschlagen"
- PostgreSQL-Status pruefen: `docker compose ps postgres`
- PostgreSQL-Logs: `docker compose logs postgres`

### Langsame Antworten
- GPU-Unterstuetzung aktivieren (siehe oben)
- RAM pruefen: GLM-4 benoetigt mindestens 8 GB
- Alternative: Kleineres Modell verwenden (`OLLAMA_MODEL=glm4:7b` in `.env`)

## Architektur

```
                    +-------------------+
                    |  Client (curl,    |
                    |  Browser, App)    |
                    +--------+----------+
                             |
                             | HTTP :3939
                             v
                    +-------------------+
                    |  Agent Server     |
                    |  (Node.js/Express)|
                    +--------+----------+
                             |
               +-------------+-------------+
               |                           |
               v                           v
    +-------------------+       +-------------------+
    |  Ollama           |       |  PostgreSQL       |
    |  (GLM-4 Model)    |       |  (Conversations,  |
    |  :11434           |       |   Memory)  :5432  |
    +-------------------+       +-------------------+
```

## Umgebungsvariablen

| Variable | Standard | Beschreibung |
|----------|----------|-------------|
| `OLLAMA_HOST` | `http://ollama:11434` | Ollama API URL |
| `OLLAMA_MODEL` | `glm4` | Ollama Modell-Name |
| `POSTGRES_USER` | `agents` | PostgreSQL Benutzer |
| `POSTGRES_PASSWORD` | `agents123` | PostgreSQL Passwort |
| `POSTGRES_DB` | `agent_db` | PostgreSQL Datenbank |
| `PORT` | `3939` | Server Port |
| `NODE_ENV` | `production` | Node.js Umgebung |
