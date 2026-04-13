# Mimir — Headless Intelligence Layer

> Claude Code reads this file automatically. It describes the architecture, patterns, and conventions for the Mimir knowledge graph service.

## What Mimir Is

Mimir is a **thought partner intelligence layer** — a persistent graph-backed service that holds knowledge, surfaces connections, tracks how ideas mature over time, and processes signals through an intelligence layer that understands context. It is NOT a personal assistant with good memory. It is the memory and reasoning substrate that any AI client (Claude, Gemini, local models) can query via 7 MCP verbs or HTTP API.

## Architecture

- **Runtime:** Bun (TypeScript, runs .ts natively)
- **Graph:** FalkorDBLite (embedded, single-process, file-locked)
- **Service:** HTTP server at `localhost:4200` (launchd: `com.speki.mimir`)
- **Data:** `/Volumes/AI-Lab/falkordb-data/personal-brain/`
- **MCP:** 7 verbs exposed via MCP stdio transport (for Claude Code) or HTTP (for GoBot/Observatory)

## The 7 Verbs

| Verb | Purpose | HTTP |
|------|---------|------|
| **retain** | Capture knowledge — extract entities, relationships, facts | `POST /api/retain` |
| **recall** | Multi-strategy retrieval (semantic + graph + anchor) | `GET /api/recall?q=...` |
| **pulse** | Status check on an entity or domain | `GET /api/pulse?entity=...` |
| **reflect** | Synthesis over a time period — patterns, gaps, evolution | `GET /api/reflect` |
| **connect** | Create explicit edges between nodes | `POST /api/connect` |
| **anchor** | Set a load-bearing philosophy that constrains downstream work | `POST /api/anchor` |
| **triage** | Classify and route incoming signals (email, messages) | `POST /api/triage` |

## Key Endpoint: /api/context

`GET /api/context?q=...` — lightweight endpoint for GoBot prompt injection. Returns formatted text (not JSON) with full source material. Implements **Recursive Hydration**: when a Thought or Entity matches, follows edges to the source Episode and returns full content.

This is the primary integration point with GoBot. Called by `getMimirContext()` in `gobot/src/lib/mimir-client.ts` before every Claude invocation.

## Graph Data Model

### Node Types

| Node | Key Properties | Purpose |
|------|---------------|---------|
| **Episode** | content (full), source_type, timestamp, processed | Ground truth — raw source material, never truncated |
| **Thought** | content, embedding (1536d), source, confidence | Atomic unit of memory, vector-searchable |
| **Entity** | name, type, summary (evolving), synonyms | Person, org, project, concept, domain |
| **Anchor** | content, domain, weight | Load-bearing philosophy that constrains decisions |

### Edge Types

| Edge | From → To | Properties |
|------|-----------|------------|
| `extracted_from` | Thought → Episode | Provenance link |
| `involves` | Episode → Entity | This episode mentions this entity |
| `evolves` | Thought → Thought | Idea maturation chain |
| `contributes_to` | Thought → Entity | Insight feeds into project |
| `tensions_with` | Thought → Anchor | Content conflicts with philosophy |
| `relates_to` | Entity → Entity | General relationship |
| `constrains` | Anchor → Entity | Philosophy governs domain |

**Fact-bearing edges** (Graphiti pattern): Entity→Entity edges store `fact` (natural language), `valid_from`/`valid_until` (temporal window), `episode_ids` (provenance list). This makes edges knowledge containers, not just structural links.

## Ported Patterns (Sources to Review Quarterly)

These patterns were ported from established projects. Review their repos quarterly for evolution.

### From Mem0 (`github.com/mem0ai/mem0`)
- **Entity Action Intents** — extraction returns ADD/UPDATE/INVALIDATE per entity. Entities evolve via LLM-driven merge, not `content.slice(0, 100)`. Implemented in `extraction.ts` and `retain.ts`.
- **Soft Invalidation** — contradicted entities get `[INVALIDATED]` prefix, not deleted. Preserves temporal integrity.

### From Graphiti (`github.com/getzep/graphiti`)
- **Fact-Bearing Edges** — edges store full natural-language facts with embeddings and temporal validity windows. Implemented in `graph.ts:createFactEdge()`.
- **Episode Provenance Lists** — edges accumulate `episode_ids[]` as multiple episodes reference the same relationship.
- **Temporal Edge Validity** — `valid_from`/`valid_until` on all edges enables time-sliced queries.

### From R2R / Hindsight
- **Recursive Hydration** — `hydrateNode()` in `graph.ts` follows edges from any node back to its source Episode. Every retrieval endpoint uses this primitive.
- **Multi-Strategy Retrieval** — recall uses semantic (vector), graph (text match + traversal), and anchor search in parallel.

### Evaluated but Not Yet Ported
- **Graphiti MinHash/LSH deduplication** — two-phase entity dedup (deterministic first, LLM only for ambiguous). Currently using simple name matching.
- **RAGFlow grounded citation** — forces LLM to prove source usage. Currently using provenance labels.
- **Youtu-GraphRAG hierarchical summaries** — community-level reasoning. Deferred until student data grows.
- **Graphiti edge-level vector embeddings** — semantic search on relationships. Deferred for FalkorDBLite complexity reasons.

## Critical Patterns

### Episode = Ground Truth
Episodes store full raw content. Never truncated, never summarized. Every other node (Thought, Entity, Edge) is derived from Episodes and links back to them for provenance.

### Entity Summaries Evolve
When `retain()` processes new content, the extraction LLM receives existing entity summaries as context and returns action intents:
- **ADD** — new entity, create with LLM-generated `fact_summary`
- **UPDATE** — existing entity, LLM merges old + new into coherent summary
- **INVALIDATE** — existing entity contradicted, soft-delete with `[INVALIDATED]` prefix

### Hydration is Automatic
`hydrateNode(id, label)` in `graph.ts` is the core retrieval primitive. It follows `extracted_from` (Thought→Episode) or `involves` (Episode→Entity) edges to return full source content. All retrieval endpoints use it.

### Anchor Tension Detection
When new content is retained, `retain()` checks active Anchors in relevant domains. If the new content tensions with an Anchor, it creates a `tensions_with` edge and surfaces the tension in the response.

## Service Management

```bash
# Health check
curl http://localhost:4200/health

# Restart
launchctl unload ~/Library/LaunchAgents/com.speki.mimir.plist
launchctl load ~/Library/LaunchAgents/com.speki.mimir.plist

# Logs (stderr goes to launchd log)
tail -f /Volumes/AI-Lab/logs/mimir-service.log

# Test retain
curl -X POST http://localhost:4200/api/retain \
  -H "Content-Type: application/json" \
  -d '{"content": "...", "source": "document"}'

# Test context (what GoBot sees)
curl "http://localhost:4200/api/context?q=..."
```

## Environment

- `ANTHROPIC_API_KEY` — required for LLM extraction (Haiku). Read from `.env` in repo root or parent directory.
- `MIMIR_DATA_PATH` — FalkorDB data directory (default: `/Volumes/AI-Lab/falkordb-data/personal-brain`)
- `MIMIR_PORT` — HTTP port (default: 4200)
- `MIMIR_EXTRACTION_MODEL` — override extraction model (default: `claude-haiku-4-5-20251001`)
- `BRAIN_DISABLE_LLM` — set to `true` to defer all extraction (for testing)

## Known Issues / Tech Debt

1. **Noisy entity extraction** — Haiku over-extracts from section headers and capitalized words. Needs a stop-word list or stricter schema.
2. **Entity deduplication is naive** — simple case-insensitive name match + synonyms. Should port Graphiti's MinHash/LSH for fuzzy matching.
3. **No edge-level vector search** — fact-bearing edges store text but not embeddings. Semantic relationship search requires edge embeddings.
4. **Factual contradiction detection** — tension detection works for Anchors but not for ordinary fact-bearing edges. Should extend to flag when a new fact contradicts an existing edge.
5. **Single-entity hydration** — `hydrateNode()` returns the most recent Episode only (`LIMIT 1`). High-stakes reasoning may need `hydrateAll()` for complete provenance.
