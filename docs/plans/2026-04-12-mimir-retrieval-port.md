# Mimir Retrieval Port — Mem0/Graphiti Patterns

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port three proven patterns from Mem0 and Graphiti into Mimir to fix naive entity creation, dumb edges, and manual hydration — making Mimir a reliable knowledge retrieval system instead of a truncating index card reader.

**Architecture:** Three targeted refactors to existing Mimir files. (1) Extraction returns "action intents" (ADD/UPDATE/INVALIDATE) per entity so retain() can evolve summaries via LLM instead of `content.slice(0, 100)`. (2) Edges store natural-language facts with `valid_at`/`invalid_at` timestamps and episode provenance lists. (3) A `hydrateNode()` graph helper auto-fetches source Episode content for any retrieved node, replacing hand-coded hydration in each endpoint.

**Tech Stack:** Bun, FalkorDB (FalkorDBLite), Anthropic SDK (Haiku for extraction), existing Mimir codebase

**Constraints from advisor:** Skip edge-level vector embeddings for this MVP — prioritize fact text + `valid_at` timestamp. Edge-embedding search is Phase 2.

---

## File Structure

### Modified Files
| File | Changes |
|------|---------|
| `src/types.ts` | Add `EntityAction`, `FactEdge` types; extend `ExtractionResult` with entity actions and edge facts |
| `src/extraction.ts` | New extraction prompt that returns action intents (ADD/UPDATE/INVALIDATE) per entity and fact strings per relationship |
| `src/graph.ts` | Add `hydrateNode()`, `updateEntitySummary()`, `createFactEdge()`, `invalidateEdge()` helpers |
| `src/verbs/retain.ts` | Rewrite entity handling to use action intents; create fact-bearing edges; evolve entity summaries |
| `src/verbs/recall.ts` | Use `hydrateNode()` for automatic episode hydration in all results |
| `src/verbs/process-queue.ts` | Match retain.ts entity handling changes (same pattern, deferred path) |
| `src/service.ts` | Simplify `/api/context` to use `hydrateNode()` instead of inline Cypher |

---

## Task 1: Extend Type Definitions

**Files:**
- Modify: `src/types.ts`

- [ ] **Step 1: Add entity action intent type**

Add after the `ExtractionResult` interface (line 238):

```typescript
/**
 * Action intent for an entity during extraction.
 * Ported from Mem0's ADD/UPDATE/DELETE pattern.
 * - ADD: genuinely new entity, create fresh
 * - UPDATE: entity exists, merge new info into summary
 * - INVALIDATE: entity info is contradicted, soft-delete old summary
 */
export type EntityAction = "ADD" | "UPDATE" | "INVALIDATE";

export interface ExtractedEntityWithAction {
  name: string;
  type: EntityType;
  canonical_name?: string;
  /** What the LLM knows about this entity from the current episode */
  fact_summary: string;
  /** How this entity relates to existing knowledge */
  action: EntityAction;
}
```

- [ ] **Step 2: Add fact-bearing edge type**

Add after the `ExtractedEntityWithAction` interface:

```typescript
/**
 * Relationship with a natural-language fact, ported from Graphiti.
 * Edges are knowledge containers, not just structural links.
 */
export interface ExtractedFact {
  from: string;
  to: string;
  edge_type: EdgeType;
  /** Full natural-language description of the relationship */
  fact: string;
  /** When this fact became true (ISO 8601 or null if unknown) */
  valid_at: string | null;
  /** When this fact stopped being true (ISO 8601 or null if still true) */
  invalid_at: string | null;
}
```

- [ ] **Step 3: Extend ExtractionResult to include new fields**

Replace the existing `ExtractionResult` interface with:

```typescript
export interface ExtractionResult {
  entities: Array<{
    name: string;
    type: EntityType;
    canonical_name?: string;
  }>;
  /** Entity action intents — present when LLM has existing entity context */
  entity_actions?: ExtractedEntityWithAction[];
  relationships: Array<{
    from: string;
    to: string;
    type: EdgeType;
    rationale: string;
  }>;
  /** Fact-bearing relationships — richer than relationships[] */
  facts?: ExtractedFact[];
  is_anchor: boolean;
  anchor_domain: string | null;
  commitment: string | null;
  deadline: string | null;
  confidence: number;
  domains: string[];
}
```

- [ ] **Step 4: Extend TemporalEdge for fact storage**

Replace the existing `TemporalEdge` interface with:

```typescript
export interface TemporalEdge {
  type: EdgeType;
  created_at: number;
  valid_from: number;
  valid_until: number | null;
  confidence: number;
  source_episode_id: string | null;
  /** Full natural-language fact (Graphiti pattern). Null for structural edges. */
  fact: string | null;
  /** List of episode IDs that contributed to this edge (Graphiti provenance pattern). */
  episode_ids: string[];
}
```

- [ ] **Step 5: Commit**

```bash
cd /Volumes/AI-Lab/Projects/mimir
git add src/types.ts
git commit -m "feat: add EntityAction, ExtractedFact types for Mem0/Graphiti port"
```

---

## Task 2: Add Graph Helpers (hydrateNode, updateEntitySummary, createFactEdge)

**Files:**
- Modify: `src/graph.ts`

- [ ] **Step 1: Add `hydrateNode()` — the core hydration primitive**

Add after the `vectorSearch()` function (line 225):

```typescript
/**
 * Hydrate a node with its source Episode content.
 * Follows extracted_from (Thought→Episode) or involves (Episode→Entity) edges.
 * Returns the full Episode content, or null if no linked episode exists.
 *
 * This is the "Recursive Hydration" pattern from R2R/Graphiti —
 * finding a node is Phase 1, fetching its source material is Phase 2.
 */
export async function hydrateNode(
  nodeId: string,
  nodeLabel: "Thought" | "Entity",
): Promise<{ episodeId: string; content: string; source_type: string } | null> {
  const g = getGraph();

  let cypher: string;
  if (nodeLabel === "Thought") {
    // Thought -[extracted_from]-> Episode
    cypher = `
      MATCH (t:Thought {id: $id})-[:extracted_from]->(ep:Episode)
      RETURN ep.id AS episodeId, ep.content AS content, ep.source_type AS source_type
      LIMIT 1`;
  } else {
    // Entity <-[involves]- Episode (reverse direction)
    cypher = `
      MATCH (e:Entity {id: $id})<-[:involves]-(ep:Episode)
      RETURN ep.id AS episodeId, ep.content AS content, ep.source_type AS source_type
      ORDER BY ep.timestamp DESC
      LIMIT 1`;
  }

  try {
    const result = await g.query(cypher, { params: { id: nodeId } });
    if (result.data && result.data.length > 0) {
      const row = result.data[0] as Record<string, unknown>;
      return {
        episodeId: row.episodeId as string,
        content: row.content as string,
        source_type: row.source_type as string,
      };
    }
  } catch {
    // Non-fatal — node may not have an episode link
  }
  return null;
}
```

- [ ] **Step 2: Add `updateEntitySummary()` — LLM-driven entity evolution**

Add after `hydrateNode()`:

```typescript
/**
 * Update an entity's summary by merging new information via LLM.
 * Ported from Mem0's UPDATE pattern — the LLM sees the old summary
 * and the new episode context, then produces a merged summary.
 *
 * Also updates the `updated_at` timestamp.
 */
export async function updateEntitySummary(
  entityId: string,
  newSummary: string,
): Promise<void> {
  const g = getGraph();
  await g.query(
    `MATCH (e:Entity {id: $id})
     SET e.summary = $summary, e.updated_at = $now`,
    { params: { id: entityId, summary: newSummary, now: Date.now() } },
  );
}

/**
 * Soft-invalidate an entity's summary (Mem0 DELETE/INVALIDATE pattern).
 * Prepends "[INVALIDATED]" to the summary rather than deleting the node.
 * The entity and its edges are preserved for historical graph traversal.
 */
export async function invalidateEntitySummary(
  entityId: string,
): Promise<void> {
  const g = getGraph();
  await g.query(
    `MATCH (e:Entity {id: $id})
     SET e.summary = '[INVALIDATED] ' + e.summary, e.updated_at = $now`,
    { params: { id: entityId, now: Date.now() } },
  );
}
```

- [ ] **Step 3: Add `createFactEdge()` — fact-bearing edge creation**

Add after `invalidateEntitySummary()`:

```typescript
/**
 * Create a fact-bearing edge between two nodes.
 * Ported from Graphiti — edges store natural-language facts,
 * temporal validity windows, and provenance episode lists.
 *
 * If a similar edge already exists (same from/to/type), appends
 * the episode to the existing edge's provenance list instead of
 * creating a duplicate (Graphiti dedup pattern).
 */
export async function createFactEdge(
  fromLabel: string,
  fromId: string,
  toLabel: string,
  toId: string,
  edgeType: EdgeType,
  fact: string,
  episodeId: string,
  validAt?: number | null,
  invalidAt?: number | null,
): Promise<void> {
  const g = getGraph();
  const now = Date.now();

  // Check for existing edge of same type between same nodes
  const existing = await g.query(
    `MATCH (a:${fromLabel} {id: $fromId})-[r:${edgeType}]->(b:${toLabel} {id: $toId})
     RETURN r.source_episode_id AS epId, r.fact AS fact
     LIMIT 1`,
    { params: { fromId, toId } },
  );

  if (existing.data && existing.data.length > 0) {
    // Edge exists — update fact and append episode to provenance
    // (Graphiti pattern: edges accumulate episode references)
    await g.query(
      `MATCH (a:${fromLabel} {id: $fromId})-[r:${edgeType}]->(b:${toLabel} {id: $toId})
       SET r.fact = $fact,
           r.episode_ids = coalesce(r.episode_ids, []) + [$episodeId],
           r.valid_until = $invalidAt`,
      { params: { fromId, toId, fact, episodeId, invalidAt: invalidAt ?? null } },
    );
  } else {
    // New edge
    await g.query(
      `MATCH (a:${fromLabel} {id: $fromId}), (b:${toLabel} {id: $toId})
       CREATE (a)-[r:${edgeType} {
         type: $type,
         fact: $fact,
         created_at: $now,
         valid_from: $validFrom,
         valid_until: $validUntil,
         confidence: 1.0,
         source_episode_id: $episodeId,
         episode_ids: [$episodeId]
       }]->(b)`,
      {
        params: {
          fromId,
          toId,
          type: edgeType,
          fact,
          now,
          validFrom: validAt ?? now,
          validUntil: invalidAt ?? null,
          episodeId,
        },
      },
    );
  }
}
```

- [ ] **Step 4: Commit**

```bash
git add src/graph.ts
git commit -m "feat: add hydrateNode, updateEntitySummary, createFactEdge graph helpers

Ported from Mem0 (entity evolution via LLM-driven update/invalidate)
and Graphiti (fact-bearing edges with temporal validity and episode
provenance lists). hydrateNode is the core 'Recursive Hydration'
primitive that auto-fetches source Episode content for any node."
```

---

## Task 3: Refactor Extraction Prompt for Action Intents

**Files:**
- Modify: `src/extraction.ts`

- [ ] **Step 1: Add entity summary lookup helper**

Add after the `getAnthropicKey()` function (line 327):

```typescript
import { findEntityByName } from "./graph.js";

/**
 * Look up existing entity summaries to provide context to the extraction LLM.
 * Returns a map of canonical_name → current summary for entities that exist.
 * This enables the LLM to decide ADD vs UPDATE vs INVALIDATE.
 */
async function getExistingEntityContext(
  text: string,
): Promise<Record<string, string>> {
  // Quick keyword extraction — find capitalized phrases that might be entity names
  const namePattern = /\b([A-Z][a-z]+(?:\s[A-Z][a-z]+)*)\b/g;
  const candidates = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = namePattern.exec(text)) !== null) {
    if (match[1].length > 2) candidates.add(match[1]);
  }

  const context: Record<string, string> = {};
  for (const name of Array.from(candidates).slice(0, 10)) {
    const entity = await findEntityByName(name);
    if (entity) {
      context[entity.name] = entity.summary;
    }
  }
  return context;
}
```

- [ ] **Step 2: Write the enhanced extraction prompt**

Replace the existing `EXTRACTION_PROMPT` constant with:

```typescript
const EXTRACTION_PROMPT = `You are an entity/relationship extraction engine for a personal knowledge graph. Given text, extract structured information and return ONLY valid JSON (no markdown fences, no explanation).

Return this exact JSON structure:
{
  "entities": [
    { "name": "display name", "type": "person|org|project|concept|domain", "canonical_name": "normalized_snake_case" }
  ],
  "entity_actions": [
    {
      "name": "entity display name",
      "type": "person|org|project|concept|domain",
      "canonical_name": "normalized_snake_case",
      "fact_summary": "What this episode says about the entity — a complete, standalone description. NOT a fragment.",
      "action": "ADD|UPDATE|INVALIDATE"
    }
  ],
  "relationships": [
    { "from": "entity canonical name", "to": "entity canonical name", "type": "relates_to|constrains|involves|contributes_to|tensions_with|scoped_to|demonstrates|discussed_in|progresses_from", "rationale": "brief reason" }
  ],
  "facts": [
    {
      "from": "entity canonical name",
      "to": "entity canonical name",
      "edge_type": "relates_to|constrains|involves|contributes_to",
      "fact": "Full natural-language description of the relationship. Example: 'Kyle is the technical director of Lighthouse Holyoke'",
      "valid_at": "ISO 8601 datetime or null if unknown",
      "invalid_at": "ISO 8601 datetime or null if still true"
    }
  ],
  "is_anchor": false,
  "anchor_domain": null,
  "commitment": null,
  "deadline": null,
  "confidence": 0.7,
  "domains": []
}

ENTITY ACTION RULES:
- ADD: Entity is not in EXISTING ENTITIES below, or no existing entities provided.
- UPDATE: Entity exists but the new text adds, corrects, or expands what we know. The fact_summary should be a MERGED description combining old + new info.
- INVALIDATE: Entity exists but the new text CONTRADICTS the existing summary. This is rare.
- fact_summary must be a COMPLETE, STANDALONE description — not a fragment. Write it as if someone reading only this field would understand the entity's full context.

FACT RULES:
- facts[] stores the natural-language description of each relationship.
- Write facts as full sentences: "Catherine Gobron is the founder of Lighthouse Holyoke" not "founder".
- Include valid_at if the text implies when the relationship started.
- Include invalid_at if the text implies the relationship ended.

Rules:
- Extract entities: people, organizations, projects, concepts, domains mentioned in the text.
- Use canonical_name for dedup: if text mentions "the school" and "School Project", normalize to one canonical name like "school_project".
- is_anchor: true ONLY for deeply held philosophical beliefs, core values, or guiding principles. Be very conservative.
- commitment: if the text contains a promise or action item, extract it. Otherwise null.
- confidence: 0.0-1.0 how confident you are in the extraction quality.
- domains: list of life/work domains this text touches.

Return ONLY the JSON object. No other text.`;
```

- [ ] **Step 3: Update `extractFromText` to pass existing entity context**

Replace the LLM call section in `extractFromText` (the try block starting at line 349) with:

```typescript
  try {
    const client = new Anthropic({ apiKey });

    // Fetch existing entity context so the LLM can decide ADD vs UPDATE
    const existingContext = await getExistingEntityContext(text);
    const contextBlock = Object.keys(existingContext).length > 0
      ? `\n\nEXISTING ENTITIES (use for ADD/UPDATE/INVALIDATE decisions):\n${
          Object.entries(existingContext)
            .map(([name, summary]) => `- ${name}: ${summary}`)
            .join("\n")
        }`
      : "";

    const response = await client.messages.create({
      model,
      max_tokens: 2048,
      system: EXTRACTION_PROMPT,
      messages: [{ role: "user", content: text + contextBlock }],
    });

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      return fallbackExtraction(text);
    }

    console.error("[mimir:extraction] Raw LLM response:", textBlock.text.slice(0, 500));
    return parseExtractionResponse(textBlock.text, text);
  } catch (err) {
    console.error("[mimir:extraction] LLM extraction failed, deferring to queue:", err);
    return deferredExtraction();
  }
```

- [ ] **Step 4: Update `parseExtractionResponse` to handle new fields**

In `parseExtractionResponse`, add parsing for the new `entity_actions` and `facts` fields after the `relationships` parsing block:

```typescript
    const entity_actions = Array.isArray(parsed.entity_actions)
      ? parsed.entity_actions.map(
          (ea: any) => ({
            name: String(ea.name ?? ""),
            type: validateEntityType(String(ea.type ?? "concept")),
            canonical_name: ea.canonical_name ? String(ea.canonical_name) : undefined,
            fact_summary: String(ea.fact_summary ?? ""),
            action: ["ADD", "UPDATE", "INVALIDATE"].includes(ea.action) ? ea.action : "ADD",
          }),
        )
      : undefined;

    const facts = Array.isArray(parsed.facts)
      ? parsed.facts.map(
          (f: any) => ({
            from: String(f.from ?? ""),
            to: String(f.to ?? ""),
            edge_type: validateEdgeType(String(f.edge_type ?? "relates_to")),
            fact: String(f.fact ?? ""),
            valid_at: f.valid_at ? String(f.valid_at) : null,
            invalid_at: f.invalid_at ? String(f.invalid_at) : null,
          }),
        )
      : undefined;
```

Then include them in the return object:

```typescript
    return {
      entities,
      entity_actions,
      relationships,
      facts,
      is_anchor: Boolean(parsed.is_anchor),
      // ... rest unchanged
    };
```

- [ ] **Step 5: Commit**

```bash
git add src/extraction.ts
git commit -m "feat: extraction returns action intents and fact-bearing relationships

LLM now receives existing entity summaries as context and returns
ADD/UPDATE/INVALIDATE intents per entity (Mem0 pattern) and full
natural-language facts per relationship (Graphiti pattern)."
```

---

## Task 4: Refactor retain.ts for Entity Evolution and Fact Edges

**Files:**
- Modify: `src/verbs/retain.ts`

- [ ] **Step 1: Import new graph helpers**

Update imports at the top of the file:

```typescript
import {
  createNode,
  createEdge,
  createFactEdge,
  findEntityByName,
  getGraph,
  vectorSearch,
  updateEntitySummary,
  invalidateEntitySummary,
} from "../graph.js";
```

- [ ] **Step 2: Rewrite entity handling to use action intents**

Replace the entity creation block (lines 90-134) with:

```typescript
  // 3-4. Entity handling with action intents (Mem0 ADD/UPDATE/INVALIDATE pattern)
  const entityIds: Record<string, string> = {};
  if (!isQueued) {
    // Prefer entity_actions (action-intent-aware) over plain entities
    const entityList = extraction.entity_actions ?? extraction.entities.map((e) => ({
      ...e,
      fact_summary: "",
      action: "ADD" as const,
    }));

    for (const entity of entityList) {
      const searchName = entity.canonical_name || entity.name;
      const existing = await findEntityByName(searchName);

      if (existing) {
        entityIds[entity.name] = existing.id;

        // Apply action intent
        if ("action" in entity) {
          if (entity.action === "UPDATE" && entity.fact_summary) {
            // Mem0 UPDATE: merge new info into existing summary
            await updateEntitySummary(existing.id, entity.fact_summary);
          } else if (entity.action === "INVALIDATE") {
            // Mem0 INVALIDATE: soft-delete the summary
            await invalidateEntitySummary(existing.id);
          }
          // ADD for existing entity = no-op (already exists)
        }
      } else {
        // New entity — create with fact_summary (not content.slice(0, 100))
        const summary = ("fact_summary" in entity && entity.fact_summary)
          ? entity.fact_summary
          : `Mentioned in: ${content.slice(0, 200)}`;
        const newId = await createNode("Entity", {
          name: entity.name,
          type: entity.type,
          summary,
          synonyms:
            entity.canonical_name && entity.canonical_name !== entity.name
              ? [entity.canonical_name]
              : [],
          created_at: now,
          updated_at: now,
        });
        entityIds[entity.name] = newId;
      }

      // Link entity to episode via "involves" (always, regardless of action)
      await createEdge(
        "Episode",
        episodeId,
        "Entity",
        entityIds[entity.name],
        "involves",
        { source_episode_id: episodeId },
      );
    }

    // Create fact-bearing edges (Graphiti pattern) if available
    if (extraction.facts && extraction.facts.length > 0) {
      for (const fact of extraction.facts) {
        const fromId = entityIds[fact.from];
        const toId = entityIds[fact.to];
        if (fromId && toId) {
          const validAt = fact.valid_at ? new Date(fact.valid_at).getTime() : null;
          const invalidAt = fact.invalid_at ? new Date(fact.invalid_at).getTime() : null;
          await createFactEdge(
            "Entity", fromId,
            "Entity", toId,
            fact.edge_type,
            fact.fact,
            episodeId,
            validAt,
            invalidAt,
          );
        }
      }
    }

    // Fallback: create plain edges from relationships[] if no facts[]
    if (!extraction.facts || extraction.facts.length === 0) {
      for (const rel of extraction.relationships) {
        const fromId = entityIds[rel.from];
        const toId = entityIds[rel.to];
        if (fromId && toId) {
          await createEdge("Entity", fromId, "Entity", toId, rel.type, {
            source_episode_id: episodeId,
            confidence: extraction.confidence,
          });
        }
      }
    }
  }
```

- [ ] **Step 3: Commit**

```bash
git add src/verbs/retain.ts
git commit -m "feat: retain uses entity action intents and fact-bearing edges

Entity creation now uses LLM-driven ADD/UPDATE/INVALIDATE (Mem0)
instead of content.slice(0, 100). Relationships stored as full
natural-language facts with temporal validity (Graphiti). Falls back
to plain edges when facts[] is not available."
```

---

## Task 5: Refactor recall.ts to Use hydrateNode()

**Files:**
- Modify: `src/verbs/recall.ts`

- [ ] **Step 1: Import hydrateNode**

Add to imports:

```typescript
import { getGraph, vectorSearch, hydrateNode } from "../graph.js";
```

- [ ] **Step 2: Replace enrichWithProvenance with hydration-based version**

Replace the `enrichWithProvenance` function (lines 168-192) with:

```typescript
/**
 * Enrich a result with full source Episode content.
 * Uses hydrateNode() — the core hydration primitive.
 * Returns full episode content (not a truncated snippet).
 */
async function enrichWithProvenance(
  result: IntermediateResult,
): Promise<string | null> {
  if (result.type !== "thought") return null;

  const hydrated = await hydrateNode(result.id, "Thought");
  if (hydrated) {
    return `${hydrated.source_type}: ${hydrated.content}`;
  }
  return null;
}
```

- [ ] **Step 3: Commit**

```bash
git add src/verbs/recall.ts
git commit -m "refactor: recall uses hydrateNode for full episode provenance

Replaces hand-coded Cypher + 80-char truncation with the hydrateNode()
primitive. Provenance now returns full Episode content."
```

---

## Task 6: Simplify /api/context to Use hydrateNode()

**Files:**
- Modify: `src/service.ts`

- [ ] **Step 1: Import hydrateNode**

Add to the imports at the top of service.ts:

```typescript
import { initGraph, closeGraph, getGraph, findEntityByName, vectorSearch, hydrateNode } from "./graph.js";
```

- [ ] **Step 2: Replace inline entity hydration with hydrateNode()**

In the `/api/context` endpoint, the Phase 2 (Entity matches) section currently uses inline Cypher to join entities to episodes. Replace with `hydrateNode()` calls.

Find the entity section (approximately lines 175-210 in the current file after today's hydration fix) and replace the entity query block with:

```typescript
    // ── Phase 2: Find Entities, hydrate via hydrateNode() ──
    const entitySections: string[] = [];
    const seenEntityNames = new Set<string>();
    for (const word of words.slice(0, 5)) {
      const r = await g.query(
        `MATCH (e:Entity)
         WHERE toLower(e.name) CONTAINS toLower($w)
         RETURN e.id AS id, e.name AS name, e.type AS type, e.summary AS summary
         LIMIT 3`,
        { params: { w: word } },
      );
      if (r.data) {
        for (const row of r.data as Record<string, unknown>[]) {
          const name = row.name as string;
          const id = row.id as string;
          if (seenEntityNames.has(name)) continue;
          seenEntityNames.add(name);

          // Hydrate: fetch source episode for this entity
          const hydrated = await hydrateNode(id, "Entity");
          if (hydrated && !seenEpisodes.has(hydrated.content.slice(0, 80))) {
            seenEpisodes.add(hydrated.content.slice(0, 80));
            const content = hydrated.content.length > MAX_EPISODE_CHARS
              ? hydrated.content.slice(0, MAX_EPISODE_CHARS) + "… [truncated]"
              : hydrated.content;
            entitySections.push(
              `- **${name}** (${row.type}): [SOURCE: ${hydrated.source_type}]\n${content}`,
            );
          } else {
            // No episode linked — show the entity summary as-is
            const summary = row.summary as string;
            entitySections.push(
              `- **${name}** (${row.type}): ${summary || "[no source material]"}`,
            );
          }
        }
      }
    }
```

- [ ] **Step 3: Commit**

```bash
git add src/service.ts
git commit -m "refactor: /api/context uses hydrateNode() for entity hydration

Replaces inline OPTIONAL MATCH Cypher with the hydrateNode() primitive.
Same behavior, but the hydration logic is now in one place (graph.ts)
instead of duplicated across endpoints."
```

---

## Task 7: Update process-queue.ts to Match retain.ts

**Files:**
- Modify: `src/verbs/process-queue.ts`

- [ ] **Step 1: Update entity creation to match retain.ts pattern**

Find the entity creation block in `process-queue.ts` (around line 87-90) where it does:

```typescript
summary: `Mentioned in context: ${content.slice(0, 100)}`,
```

Replace with the same action-intent pattern from retain.ts. Since process-queue re-runs extraction on queued episodes, it should use the same entity handling logic:

```typescript
        // Use fact_summary from entity_actions if available (Mem0 pattern)
        const entityAction = extraction.entity_actions?.find(
          (ea) => ea.name === entity.name || ea.canonical_name === entity.canonical_name,
        );
        const summary = entityAction?.fact_summary
          ? entityAction.fact_summary
          : `Mentioned in: ${content.slice(0, 200)}`;

        // Apply action intent
        if (existing && entityAction) {
          if (entityAction.action === "UPDATE" && entityAction.fact_summary) {
            await updateEntitySummary(existing.id, entityAction.fact_summary);
          } else if (entityAction.action === "INVALIDATE") {
            await invalidateEntitySummary(existing.id);
          }
        }
```

Import the new helpers at the top of the file:

```typescript
import {
  createNode,
  createEdge,
  createFactEdge,
  findEntityByName,
  getGraph,
  updateEntitySummary,
  invalidateEntitySummary,
} from "../graph.js";
```

- [ ] **Step 2: Add fact-bearing edge creation (same pattern as retain.ts)**

After the entity creation loop, add the same fact-edge creation block as retain.ts:

```typescript
      // Create fact-bearing edges if available
      if (extraction.facts && extraction.facts.length > 0) {
        for (const fact of extraction.facts) {
          const fromId = entityIds[fact.from];
          const toId = entityIds[fact.to];
          if (fromId && toId) {
            const validAt = fact.valid_at ? new Date(fact.valid_at).getTime() : null;
            const invalidAt = fact.invalid_at ? new Date(fact.invalid_at).getTime() : null;
            await createFactEdge(
              "Entity", fromId,
              "Entity", toId,
              fact.edge_type,
              fact.fact,
              episodeId,
              validAt,
              invalidAt,
            );
          }
        }
      }
```

- [ ] **Step 3: Commit**

```bash
git add src/verbs/process-queue.ts
git commit -m "feat: process-queue uses entity action intents and fact edges

Matches retain.ts pattern — deferred episodes now get the same
entity evolution and fact-bearing edge treatment on reprocessing."
```

---

## Task 8: Restart Mimir and End-to-End Test

- [ ] **Step 1: Restart the Mimir service**

```bash
launchctl unload ~/Library/LaunchAgents/com.speki.mimir.plist
sleep 2
launchctl load ~/Library/LaunchAgents/com.speki.mimir.plist
sleep 2
curl -s http://localhost:4200/health
```

Expected: `{"status":"ok","graph":"mimir",...}`

- [ ] **Step 2: Test retain with a new episode**

```bash
curl -s -X POST http://localhost:4200/api/retain \
  -H "Content-Type: application/json" \
  -d '{"content": "Catherine and Kyle discussed the new restorative justice curriculum for Lighthouse. Catherine wants to prioritize circle practice over traditional disciplinary methods. The curriculum should launch in September 2026.", "source": "conversation"}' | python3 -m json.tool
```

Expected: Response includes `entities_extracted` with entity names. Check Mimir logs (`tail -f /Volumes/AI-Lab/logs/mimir-service.log`) for extraction output showing `entity_actions` with `fact_summary` fields and `facts` with full natural-language relationship descriptions.

- [ ] **Step 3: Test retrieval shows full hydrated content**

```bash
curl -s "http://localhost:4200/api/context?q=Lighthouse+curriculum+restorative" 
```

Expected: The response includes the full Episode content from the test above, not a truncated snippet. Entity sections show fact summaries (not `Mentioned in context: Catherine and Kyle discuss...` truncated at 100 chars).

- [ ] **Step 4: Test entity evolution**

```bash
curl -s -X POST http://localhost:4200/api/retain \
  -H "Content-Type: application/json" \
  -d '{"content": "Update on Lighthouse curriculum: Catherine decided to delay the launch to January 2027 to allow more time for staff training in restorative practices.", "source": "conversation"}' | python3 -m json.tool
```

Expected: The LLM should return an UPDATE action for the Lighthouse entity (since it already exists). Check that the entity summary in the graph reflects the merged information (both the original September date and the updated January date).

- [ ] **Step 5: Commit all and verify clean state**

```bash
cd /Volumes/AI-Lab/Projects/mimir
git status
git log --oneline -10
```

Expected: Clean working tree, 7 commits for this plan.
