# Mimir — Memory Architecture

Mimir is a graph-backed intelligence layer for the Mosscap personal AI system. It owns a single FalkorDB graph database and exposes all memory operations as named verbs via HTTP and MCP (Model Context Protocol).

**Version:** Post Phase 3 (Dual-Stream)
**Backend:** FalkorDBLite (embedded, file-based)
**Data path:** `/Volumes/AI-Lab/falkordb-data/personal-brain`
**HTTP service:** `localhost:4200`
**MCP proxy:** `mimir/src/proxy.ts` (registered in `gobot/.mcp.json`)

---

## 1. System Boundary

```
┌─────────────────────────────────────────────────────────────┐
│                     MIMIR HTTP SERVICE                       │
│              (sole FalkorDB lock holder)                     │
│                   localhost:4200                             │
│                                                              │
│  ┌──────────────┐    ┌────────────────┐  ┌───────────────┐ │
│  │  HTTP REST   │    │ Graph Engine   │  │ Consolidation │ │
│  │  8 endpoints │───>│  FalkorDB      │<─│   Worker      │ │
│  └──────────────┘    └────────────────┘  │ (every 30s)   │ │
│                                          └───────────────┘ │
└──────────────────────┬──────────────────────────────────────┘
                       │
         ┌─────────────┼─────────────┐
         │             │             │
   ┌──────────┐  ┌──────────┐  ┌──────────┐
   │  GoBot   │  │  Claude  │  │ Observatory│
   │  daemon  │  │   Code   │  │   UI      │
   │(HTTP API)│  │(MCP proxy│  │(HTTP API) │
   └──────────┘  └──────────┘  └──────────┘
```

**Design principle:** No client ever opens FalkorDB directly. Everything goes through the HTTP service. Claude Code uses the MCP proxy (`proxy.ts`) which forwards tool calls to HTTP — zero lock contention.

---

## 2. Graph Schema

### Node Types

```
Episode
  id:           UUID
  content:      string          ← raw source text (ground truth)
  source_type:  conversation | email | document | voice | meeting
  participants: string[]
  timestamp:    number (ms)     ← ingestion time (when we stored it)
  event_at:     number (ms)     ← event time (when it actually happened)
  processed:    boolean         ← false = queued for consolidation worker

Thought
  id:           UUID
  content:      string
  embedding:    float32[]       ← 1536-dim vector for semantic search
  source:       chat | voice | email | manual | meeting | distillation
  confidence:   float
  created_at:   number (ms)

Entity
  id:           UUID
  name:         string
  type:         person | org | project | concept | domain
  summary:      string          ← LLM-synthesized fact summary
  synonyms:     string[]        ← canonical name aliases for dedup
  created_at:   number (ms)
  updated_at:   number (ms)

Anchor
  id:           UUID
  content:      string          ← the load-bearing principle
  domain:       string          ← which life/work domain it constrains
  weight:       float (0-1)     ← importance weighting
  created_at:   number (ms)
```

### Edge Types (all temporally tracked)

Every edge carries: `valid_from`, `valid_until` (null = still valid), `created_at`, `confidence`, `source_episode_id`.

Fact edges additionally carry: `fact` (natural-language description), `episode_ids[]` (provenance list).

```
extracted_from   Thought ──────────────> Episode      (provenance link)
involves         Episode ──────────────> Entity       (entities in an episode)
contributes_to   Thought ──────────────> Entity       (domain tagging)
relates_to       Entity  <──────────────> Entity      (generic relationship)
constrains       Anchor  ──────────────> Entity       (principle governs domain)
involves         Episode ──────────────> Entity       (same as above)
supersedes       Anchor  ──────────────> Anchor       (principle evolution)
tensions_with    Thought ──────────────> Anchor       (conflict detected)
scoped_to        Entity  ──────────────> Entity       (org hierarchy)
progresses_from  Episode ──────────────> Episode      (session continuity)
```

---

## 3. Bitemporal Model

Mimir tracks two independent time axes — a pattern validated by Graphiti/Zep and the Chronos research (95.6% accuracy on LongMemEval).

```
WORLD TIME (event_at on Episodes)
  │
  │   "Meeting with Paul Taylor happened..."
  ▼
  2026-04-29 ──────────────────────────────────────────── ·····>
  (the thing happened)                               (future)

SYSTEM TIME (timestamp on Episodes)
  │
  │   "...Kyle told Mimir about it..."
  ▼
  2026-05-07 ──────────────────────────────────────────── ·····>
  (Mimir learned it)                                 (now)
```

**The gap matters:** If Kyle says "We finalized the HOPE budget in March" in May, the episode has `event_at = March` and `timestamp = May`. Without this split, all March knowledge looks like May knowledge and `as_of` queries fail.

### Recall temporal modes

```
recall(query, as_of=T)
  → "What did Mosscap know by time T?"
  → Filters Thoughts by created_at ≤ T (ingestion time cutoff)
  → Useful for: "What did we know before the board meeting?"

recall(query, intent='when')
  → "When did X happen?"
  → Searches Episodes by event_at (world time)
  → Useful for: "When did we meet with Paul Taylor?"

recall(query, intent='when', as_of=T)
  → "What events happened before T, as Mimir knew them by T?"
  → Most precise historical reconstruction
```

---

## 4. The 9 Verbs

```
retain(content, source?, participants?, event_at?)
  Purpose: Capture any text into the graph
  Returns: episode_id, thought_id, entities_extracted, connections, tensions
  Fast path: MIMIR_FAST_RETAIN=true skips LLM, defers to consolidation worker
  Authority: source_authority derived from source type, stored on all fact edges

recall(query, scope?, time_range?, as_of?, intent?)
  Purpose: Multi-strategy retrieval
  Strategies: semantic (vector), graph (text match), anchor match, temporal (episode)
  Intent routing: when/who/why/what/how → different traversal emphasis
  as_of: point-in-time query — filter Thoughts by created_at, Episodes by event_at
  Returns: ranked results with provenance Episode content

pulse(entity_or_domain)
  Purpose: Status synthesis for an entity or domain
  Returns: recent thoughts, active anchors, open commitments, connections, tensions

reflect(scope?, time_range?)
  Purpose: Distillation — detect patterns, gaps, evolving ideas
  Returns: synthesis, patterns, gaps, evolving_idea chains

connect(source, target, rationale?, edge_type?)
  Purpose: Explicit relationship creation (what the LLM noticed, not extracted)
  Creates: a temporally-tracked edge between two named nodes

anchor(content, domain, weight?)
  Purpose: Load-bearing principle creation
  Behavior: Supersedes any prior anchor in the same domain (versioned, never deleted)
  Returns: anchor_id, superseded anchors, constrained entities

forget(entity?, episode_id?, reason?)
  Purpose: Retract knowledge about an entity or episode
  Behavior: Marks entity summary [RETRACTED], sets all fact edges to belief_state='retracted'
  Source material: Episodes and Thoughts are PRESERVED (immutable ground truth)
  Effect: Entity no longer appears in /api/context; retracted facts excluded from recall

triage(content, source, source_type?)
  Purpose: Process an external signal (email, message) through the intelligence layer
  Returns: priority (high/medium/low/noise), routing, related entities, action_required

process_queue(limit?)
  Purpose: Run the consolidation worker manually
  Processes: Episodes with processed=false — runs extraction, creates entities/edges
  Used by: the background consolidation worker (every 30s) and manual triggers
```

---

## 5. Dual-Stream Architecture (Phase 3 — MAGMA Pattern)

The core insight from MAGMA research: fast ingestion and heavy consolidation must be decoupled. Every `retain()` used to block on LLM extraction (5-10s). Now:

```
retain() call
     │
     ▼ (always fast: <200ms)
┌────────────────────────────┐
│  FAST STREAM               │
│  1. Create Episode node    │
│  2. Generate embedding     │
│  3. Create Thought node    │
│  4. Link Thought→Episode   │
│  5. Return to caller       │
│                            │
│  episode.processed = false │
└────────────┬───────────────┘
             │ queued
             ▼
┌────────────────────────────┐
│  SLOW STREAM               │
│  Consolidation worker      │
│  (every 30s, batch=10)     │
│                            │
│  For each unprocessed ep:  │
│  1. extractFromText() LLM  │
│  2. Create/upsert entities │
│  3. Create fact edges      │
│  4. Apply action intents   │
│     (ADD/UPDATE/INVALIDATE)│
│  5. Mark ep.processed=true │
└────────────────────────────┘
```

**Configuration (environment variables):**

```
MIMIR_FAST_RETAIN=true          # Enable always-defer mode (O(1) retain)
MIMIR_CONSOLIDATION_INTERVAL=30000   # Worker interval in ms (default: 30s)
MIMIR_CONSOLIDATION_BATCH=10         # Episodes per worker pass (default: 10)
```

**Queue monitoring:**

```
GET /api/queue/status
→ { pending: 3, oldest_pending_at: 1746748800000, consolidation_interval_ms: 30000, ... }
```

---

## 6. Recall Pipeline

```
recall(query, as_of?, intent?)
         │
         ├──── semantic search (always runs)
         │     └─ generate embedding → vector similarity on Thought.embedding
         │        post-filter: created_at ≤ as_of (if set)
         │
         ├──── graph search (always runs)
         │     └─ text match on Thought.content
         │        filter: created_at ≤ as_of (if set)
         │        returns: connected entity names
         │
         ├──── anchor search (always runs)
         │     └─ text match on Anchor.content + domain
         │        filter: created_at ≤ as_of (if set)
         │        score boost: weight × 0.9
         │
         └──── temporal search (intent='when' only)
               └─ text match on Episode.content
                  filter: event_at ≤ as_of (if set)   ← world time, not ingestion time
                  returns: Thoughts extracted_from matching Episodes
                  source: "temporal"
         │
         ▼
    merge + deduplicate by node ID
    multi-strategy boost: +0.15 if found by 2+ strategies
    intent-based reweighting (who/why → boost graph results)
         │
         ▼
    top 10 results
    hydrate with provenance: Thought → Episode (full content)
         │
         ▼
    RecallResponse { results, query, strategies_used, as_of?, intent? }
```

---

## 7. Retention Flow (retain verb detailed)

```
retain(content, source, participants, event_at)
         │
         ▼ MIMIR_FAST_RETAIN check
    ┌────────────────────────────────────────────┐
    │ Normal mode              │ Fast mode         │
    │ extractFromText() → LLM  │ isQueued = true   │
    │ 5-10s wait               │ immediate         │
    └──────────────────────────┴───────────────────┘
         │
         ▼
    Create Episode node
      content, source_type, participants
      timestamp = now (ingestion time)
      event_at = supplied OR now (event time)
      processed = !isQueued
         │
         ▼ (only if !isQueued — skipped in fast mode)
    For each extracted entity:
      findEntityByName() → exists?
        YES → apply action intent (ADD/UPDATE/INVALIDATE)
        NO  → createNode(Entity, { name, type, summary, synonyms })
      createEdge(Episode→Entity, "involves")

    For each extracted fact:
      createFactEdge(Entity→Entity, fact, validAt, invalidAt)
         │
         ▼
    generateEmbedding(content) → 1536-dim vector
    vectorSearch(embedding, k=10) → check for evolving thought (score > 0.90)
    createNode(Thought, { content, embedding, source, confidence })
    createEdge(Thought→Episode, "extracted_from")
         │
         ▼
    evaluateTension(thought, anchors) → detect principle conflicts
         │
         ▼
    Return RetainResponse
      { stored, thought_id, episode_id, entities_extracted,
        connections, tensions, extracted: { commitment, deadline, ... } }
```

---

## 8. Indexes

```
Entity(name)          ← entity lookup by name (findEntityByName)
Thought(created_at)   ← temporal queries on thoughts
Anchor(domain)        ← domain-scoped anchor queries
Episode(timestamp)    ← ingestion-time ordering
Episode(event_at)     ← NEW: event-time ordering (Phase 1+2)
Thought(embedding)    ← VECTOR INDEX: semantic similarity search (1536-dim, cosine)
```

---

## 9. HTTP API Reference

| Method | Path | Parameters | Description |
|--------|------|------------|-------------|
| GET | /health | — | Service health + uptime |
| GET | /api/queue/status | — | Consolidation queue depth + config |
| POST | /api/retain | content, source?, participants?, event_at? | Capture to graph |
| GET | /api/recall | q, scope?, from?, to?, as_of?, intent? | Retrieve knowledge |
| GET | /api/pulse | entity | Entity/domain status |
| GET | /api/reflect | scope?, from?, to? | Pattern distillation |
| POST | /api/connect | source, target, rationale?, edge_type? | Create explicit edge |
| POST | /api/anchor | content, domain, weight? | Load-bearing principle |
| POST | /api/forget | entity? OR episode_id?, reason? | Retract entity/episode |
| POST | /api/triage | content, source, source_type? | External signal routing |
| POST | /api/process-queue | limit? | Manual consolidation trigger |
| GET | /api/context | q, as_of? | GoBot prompt injection (filtered) |
| GET | /api/entities | — | Entity list for triage |

---

## 9b. Context Endpoint — Knowledge Injection Pipeline

The `/api/context` endpoint is what GoBot injects into Claude's system prompt on every message. Phase 5 adds belief_state filtering so Claude never sees retracted or invalidated knowledge.

```
GET /api/context?q=<query>&as_of=<epoch_ms>
         │
         ├── Phase 1: Thought text match
         │   WHERE toLower(content) CONTAINS query
         │     AND created_at ≤ as_of  (if set)
         │   → hydrate to source Episode (full content)
         │   → output: "Related knowledge (full source)"
         │
         ├── Phase 2: Entity name match
         │   WHERE name CONTAINS query
         │     AND summary NOT STARTS WITH '[INVALIDATED]'
         │     AND summary NOT STARTS WITH '[RETRACTED]'    ← Phase 5
         │   → hydrate to source Episode
         │   → output: "Known entities (with source material)"
         │
         ├── Phase 2b: Confirmed/asserted fact edges         ← Phase 5
         │   For each matched entity:
         │   WHERE valid_until IS NULL
         │     AND belief_state IN ['confirmed', 'asserted']
         │     AND fact IS NOT NULL
         │     AND valid_from ≤ as_of  (if set)
         │   → output: "Confirmed facts: Kyle → HOPE Center: Kyle is talent buyer [✓]"
         │
         └── Phase 3: Active anchors (weight > 0)
             → output: "Active anchors"
```

**What gets filtered out (Phase 5):**
- Entity summaries marked `[INVALIDATED]` or `[RETRACTED]`
- Fact edges with `belief_state = 'weakened'` or `'retracted'`
- Thoughts ingested after `as_of` (if set)
- Fact edges with `valid_from > as_of` (if set)

**What is always preserved:**
- Episode raw content (immutable ground truth, always shown regardless of belief state)
- Thoughts (linked to Episodes by extracted_from edge)
- Anchors (load-bearing principles are never automatically filtered)

## 9c. Forget — Retraction Model

```
forget("ForgettableTestCo", "No longer relevant")
         │
         ├── Find Entity by name
         ├── SET summary = '[RETRACTED] ' + existing_summary
         ├── MATCH (a:Entity)-[r]-(b:Entity {id: entity.id})
         │   WHERE r.valid_until IS NULL
         │     AND r.belief_state <> 'retracted'
         │     AND r.fact IS NOT NULL
         │   SET r.belief_state = 'retracted', r.valid_until = now
         └── Return: { retracted: true, edges_retracted: N }

What is NOT touched:
  - Episode nodes (raw content preserved)
  - Thought nodes (text preserved)
  - Structural edges (involves, extracted_from, etc.)

Effect on /api/context:
  - Entity section: entity skipped (summary starts with [RETRACTED])
  - Fact edges section: retracted edges excluded (belief_state filter)
  - Related knowledge: Episode content MAY still appear (Thought match)
```

## 10. MCP Proxy

Claude Code sessions (including GoBot's `claude -p` subprocesses) access Mimir via `src/proxy.ts` — a lightweight MCP stdio server that proxies all 8 verbs to the HTTP service.

**Why proxy, not direct:** The HTTP service holds the exclusive FalkorDB lock. Every subprocess that tried to open FalkorDB directly caused lock contention and 2-3 minute initialization stalls. The proxy adds <100ms startup (no DB open) and forwards each tool call via HTTP.

```
gobot/.mcp.json
  └─ "mimir": { command: "bun", args: ["run", "src/proxy.ts"] }
                │
                ▼
         proxy.ts (MCP stdio)
         8 tools: retain, recall, pulse, reflect,
                  connect, anchor, triage, process_queue
         headers: X-Mimir-Source: claude-code
         timeout: 10s per call
                │
                ▼
         HTTP POST/GET localhost:4200/api/...
                │
                ▼
         Mimir HTTP service (FalkorDB lock holder)
```

The `X-Mimir-Source` header tags every call with its origin (claude-code, voice, telegram, observatory) for future routing/auditing logic.

---

## 11. Phases (All Shipped)

| Phase | Status | Description |
|-------|--------|-------------|
| 1 | ✅ Shipped | `event_at` on Episodes + index |
| 2 | ✅ Shipped | `as_of` + `intent` in recall, temporal search strategy |
| 3 | ✅ Shipped | Dual-stream: consolidation worker + MIMIR_FAST_RETAIN |
| 4 | ✅ Shipped | `belief_state` + `source_authority` on fact edges |
| 5 | ✅ Shipped | `/api/context` temporal + belief_state filtering |
| 6 | ✅ Shipped | `forget()` verb — entity + episode retraction |

---

## 12. Key Design Decisions

**Gatekeeper pattern:** FalkorDB must have exactly one owner process. Everything else uses the HTTP protocol. Learned through three iterations (in-process → subprocess → HTTP service).

**Episode as ground truth:** Content is never transformed before storage. The Episode node holds the exact raw text. Extraction is an enrichment pass, not a replacement. This prevents the "telephone game" problem where each re-extraction drifts from the original.

**Dual time axes:** Ingestion time (timestamp) and event time (event_at) are stored separately. The gap between them is where historical reasoning lives.

**Consolidation isolation:** Heavy operations (LLM extraction, entity merging, contradiction detection) run in the background worker, never on the retain() hot path. retain() is always O(1) graph append.

**Recursive hydration:** recall() returns full Episode content, not truncated snippets. When a Thought matches, hydrateNode() follows the extracted_from edge to get the source Episode. This prevents the "breadcrumb without the loaf" problem — Claude sees complete context, not fragments it might fill with hallucinations.
