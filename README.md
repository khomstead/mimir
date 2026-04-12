# Mimir

**Headless intelligence layer for the Speki ecosystem.**

A graph-backed knowledge substrate that captures thoughts, extracts entities and relationships, detects philosophical tensions, and serves intelligence to any AI client via MCP.

Named for the Norse figure whose disembodied head served as Odin's thought partner and advisor — matching the "headless intelligence server" architecture.

## What It Does

Mimir is not a personal assistant with good memory. It is a **thought partner** — a system that:
- Holds philosophical commitments (Anchors) steady while execution moves fast
- Surfaces connections across domains that you wouldn't notice on your own
- Tracks how ideas mature over time via evolves edges
- Processes external signals (email, messages) through an intelligence layer that understands context

## 7 Verbs

| Verb | Stage | What it does |
|------|-------|-------------|
| **retain** | Capture | Universal capture. Extracts entities, relationships, detects anchor-grade content, checks for tensions. |
| **recall** | Retrieval | Multi-strategy search: semantic (vector), graph traversal, anchor matching. Ranked + deduplicated. |
| **pulse** | Retrieval | Status synthesis around an entity or domain. Recent thoughts, anchors, commitments, tensions. |
| **reflect** | Synthesis | Distillation. Pattern detection, evolving ideas, domain gaps. |
| **connect** | Synthesis | Explicit human-created edges. "I see a connection the system hasn't noticed." |
| **anchor** | Governance | Create load-bearing philosophies. Old anchors get supersedes edges, never silent deletion. |
| **triage** | Governance | External signal routing. Priority assessment, anchor relevance, entity matching. |

Plus `process_queue` — backfills entity extraction on Episodes that were captured without an LLM.

## Architecture

```
Input (voice/chat/email/text)
  → Intelligence Layer (extract entities + relationships)
  → Graph (FalkorDBLite — store with temporal tracking)
  → MCP Protocol (serve to any AI client)
  → Action hand-off (if commitment/reminder detected)
```

**Graph database:** FalkorDBLite (Redis-compatible, Cypher queries, vector indexes, embedded)
**LLM extraction:** Claude Haiku (configurable, falls back to queue-not-fallback pattern)
**Embeddings:** OpenAI text-embedding-3-small (1536 dimensions)
**Transport:** MCP stdio (Claude Code, Cursor, etc.)

### Node Types
- **Entity** — person, org, project, concept, domain
- **Thought** — captured insight with vector embedding (immutable)
- **Anchor** — load-bearing philosophy that constrains a domain
- **Episode** — raw source material (ground truth)

### Edge Types
All edges are temporally tracked (valid_from, valid_until, confidence):
`relates_to`, `constrains`, `extracted_from`, `evolves`, `supersedes`, `involves`, `contributes_to`, `tensions_with`, `authored_by`, `scoped_to`, `created_by`, `demonstrates`, `discussed_in`, `progresses_from`

## The Gatekeeper Pattern

Mimir runs as a **persistent service** that owns the FalkorDB lock. All clients connect via protocol — no one touches the database file directly.

```
┌─────────────────────────────────────────────┐
│           Mimir Service (port 4200)         │
│                                             │
│   FalkorDB ←── single lock holder          │
│   HTTP API ──→ GoBot, Observatory, scripts  │
│   MCP stdio ─→ Claude Code (on demand)      │
└─────────────────────────────────────────────┘
        ↑              ↑              ↑
    GoBot daemon   Observatory    Claude Code
    (fetch HTTP)   (fetch HTTP)   (MCP tools)
```

Why not let each client open FalkorDB directly? **FalkorDBLite is an embedded database** — only one process can hold the write lock. If the MCP server holds it and GoBot also tries to open it, GoBot sees empty data. The gatekeeper pattern eliminates this: one process owns the data, everyone else talks HTTP.

## Setup

### Prerequisites
- [Bun](https://bun.sh) runtime
- `redis-server` (FalkorDBLite dependency): `brew install redis`
- Anthropic API key (for entity extraction)
- OpenAI API key (for embeddings)

### Install
```bash
git clone https://github.com/khomstead/mimir.git
cd mimir
bun install
cp .env.example .env
# Edit .env with your API keys
```

### Run as persistent service (recommended)
```bash
# Start the HTTP service (port 4200)
bun run src/service.ts

# Or install as launchd service (starts at boot, restarts on crash)
cp launchd/com.speki.mimir.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.speki.mimir.plist

# Verify
curl http://localhost:4200/health
```

### HTTP API

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Health check |
| GET | `/api/context?q=...` | Formatted text for prompt injection |
| GET | `/api/recall?q=...` | Full recall with all strategies |
| GET | `/api/pulse?entity=...` | Status synthesis |
| GET | `/api/reflect` | Distillation |
| GET | `/api/entities` | Entity list (text) |
| POST | `/api/retain` | Capture content |
| POST | `/api/anchor` | Create anchor |
| POST | `/api/connect` | Create connection |
| POST | `/api/triage` | Triage signal |
| POST | `/api/process-queue` | Backfill extractions |

### Wire to Claude Code (MCP)
For Claude Code MCP tools (retain, recall, etc.), add to `.mcp.json`:
```json
{
  "mcpServers": {
    "mimir": {
      "command": "bash",
      "args": ["/path/to/mimir/start.sh"]
    }
  }
}
```
Note: The MCP stdio server (`src/index.ts`) and the HTTP service (`src/service.ts`) are separate entry points. Both connect to the same FalkorDB data. **Do not run both simultaneously** — they'll compete for the lock. When the HTTP service is running (recommended), Claude Code's MCP tools still work via the spawned stdio process when the service is briefly stopped.

### Run tests
```bash
bun test
```

## Configuration

| Env Var | Default | Purpose |
|---------|---------|---------|
| `MIMIR_DATA_PATH` | `/Volumes/AI-Lab/falkordb-data/personal-brain` | FalkorDB persistent storage path |
| `ANTHROPIC_API_KEY` | — | Required for LLM entity extraction |
| `OPENAI_API_KEY` | — | Required for semantic search embeddings |
| `MIMIR_EXTRACTION_MODEL` | `claude-haiku-4-5-20251001` | LLM model for extraction |
| `BRAIN_DISABLE_LLM` | — | Set to `true` to force queue-not-fallback (testing) |

## Federated Architecture

Mimir is designed for one-protocol, multiple-brains:
- **Kyle's Personal Brain** — personal thoughts, anchors, project work
- **School Project Brain** — student data, teacher observations (FERPA/COPPA compliant)
- **Future Brains** — each gets its own FalkorDB instance, same software

Each brain is physically isolated. Cross-brain synthesis happens in the agent's context window, not in either database.

## Part of the Speki Ecosystem

| System | What | URL |
|--------|------|-----|
| **Observatory** | PWA command center | observatory.speki.pro |
| **Mimir** | Intelligence layer | github.com/khomstead/mimir |
| **GoBot** | Agent runtime | github.com/khomstead/gobot |
