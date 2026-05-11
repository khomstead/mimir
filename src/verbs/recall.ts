/**
 * Mimir — Recall Verb
 *
 * Multi-strategy retrieval verb. Given a natural language query, it:
 * 1. Runs three search strategies in parallel (semantic, graph, anchor)
 * 2. Merges and deduplicates results
 * 3. Boosts scores for results found by multiple strategies
 * 4. Enriches top results with provenance (source Episode)
 * 5. Returns ranked RecallResponse
 */

import { getGraph, vectorSearch, hydrateNode } from "../graph.js";
import { generateEmbedding } from "../embeddings.js";
import type { RecallResult, RecallResponse } from "../types.js";

interface TimeRange {
  from?: number;
  to?: number;
}

/** Intent hint shapes which retrieval strategies run and how results are ranked. */
type RecallIntent = "when" | "who" | "why" | "what" | "how";

interface IntermediateResult {
  id: string;
  content: string;
  type: RecallResult["type"];
  score: number;
  source: string;
  created_at: number;
  connections: string[];
  strategies: Set<string>;
}

/**
 * Strategy 1: Semantic vector search.
 * Generate an embedding for the query and find similar Thoughts.
 */
async function semanticSearch(
  query: string,
): Promise<IntermediateResult[]> {
  try {
    const queryEmbedding = await generateEmbedding(query);
    const results = await vectorSearch(queryEmbedding, 10);

    return results.map((r) => ({
      id: r.id,
      content: r.content,
      type: "thought" as const,
      // Convert distance to similarity (FalkorDB cosine returns distance).
      // Non-finite scores (e.g. NaN from zero-vector embeddings in test) default to 0.5.
      score: Number.isFinite(r.score) ? 1 - r.score : 0.5,
      source: "semantic",
      created_at: r.created_at,
      connections: [],
      strategies: new Set(["semantic"]),
    }));
  } catch {
    // Vector search may fail if no Thought nodes exist yet
    return [];
  }
}

/**
 * Strategy 2: Graph traversal — text match + entity connections.
 * Finds Thoughts whose content contains the query text (case-insensitive),
 * and traverses connections to related entities.
 *
 * @param asOf  - If set, exclude Thoughts ingested after this Unix timestamp (ms).
 */
async function graphSearch(
  query: string,
  timeRange?: TimeRange,
  asOf?: number,
): Promise<IntermediateResult[]> {
  try {
    const g = getGraph();

    let timeFilter = "";
    const params: Record<string, unknown> = { query: query.toLowerCase() };

    if (timeRange?.from !== undefined) {
      timeFilter += " AND t.created_at >= $from";
      params.from = timeRange.from;
    }
    if (timeRange?.to !== undefined) {
      timeFilter += " AND t.created_at <= $to";
      params.to = timeRange.to;
    }
    if (asOf !== undefined) {
      // Point-in-time filter: only include Thoughts that existed at `asOf`
      timeFilter += " AND t.created_at <= $asOf";
      params.asOf = asOf;
    }

    const result = await g.query(
      `MATCH (t:Thought)
       WHERE toLower(t.content) CONTAINS $query${timeFilter}
       OPTIONAL MATCH (t)-[]->(e:Entity)
       RETURN t.id AS id, t.content AS content, t.created_at AS created_at,
              collect(DISTINCT e.name) AS entity_names`,
      { params },
    );

    if (!result.data || result.data.length === 0) {
      return [];
    }

    return (result.data as Record<string, unknown>[]).map((row) => ({
      id: row.id as string,
      content: row.content as string,
      type: "thought" as const,
      score: 0.7, // Base score for text match
      source: "graph",
      created_at: row.created_at as number,
      connections: (row.entity_names as string[]) || [],
      strategies: new Set(["graph"]),
    }));
  } catch {
    return [];
  }
}

/**
 * Strategy 4 (temporal): Episode-first search by event_at.
 * Used when intent = 'when'. Searches Episodes by event time (not ingestion time),
 * returns associated Thought content sorted by when events occurred.
 *
 * @param asOf - Only return Episodes with event_at <= asOf.
 */
async function temporalSearch(
  query: string,
  asOf?: number,
): Promise<IntermediateResult[]> {
  try {
    const g = getGraph();

    const params: Record<string, unknown> = { query: query.toLowerCase() };
    let asOfFilter = "";
    if (asOf !== undefined) {
      asOfFilter = " AND ep.event_at <= $asOf";
      params.asOf = asOf;
    }

    // Find Episodes whose content matches the query, filtered by event_at
    const result = await g.query(
      `MATCH (ep:Episode)
       WHERE toLower(ep.content) CONTAINS $query${asOfFilter}
       OPTIONAL MATCH (t:Thought)-[:extracted_from]->(ep)
       RETURN ep.id AS ep_id, ep.content AS ep_content,
              ep.event_at AS event_at, ep.timestamp AS ingested_at,
              t.id AS thought_id, t.content AS thought_content,
              t.created_at AS thought_created_at
       ORDER BY ep.event_at DESC
       LIMIT 10`,
      { params },
    );

    if (!result.data || result.data.length === 0) {
      return [];
    }

    return (result.data as Record<string, unknown>[])
      .filter((row) => row.thought_id !== null)
      .map((row) => ({
        id: row.thought_id as string,
        content: row.thought_content as string,
        type: "thought" as const,
        score: 0.75, // Temporal matches are high-confidence for 'when' queries
        source: "temporal",
        created_at: row.thought_created_at as number,
        connections: [],
        strategies: new Set(["temporal"]),
      }));
  } catch {
    return [];
  }
}

/**
 * Strategy 3: Anchor search.
 * Finds Anchors whose content or domain matches the query.
 * Anchors always rank high (they're foundational).
 *
 * @param asOf - If set, exclude Anchors created after this Unix timestamp (ms).
 */
async function anchorSearch(
  query: string,
  timeRange?: TimeRange,
  asOf?: number,
): Promise<IntermediateResult[]> {
  try {
    const g = getGraph();

    let timeFilter = "";
    const params: Record<string, unknown> = { query: query.toLowerCase() };

    if (timeRange?.from !== undefined) {
      timeFilter += " AND a.created_at >= $from";
      params.from = timeRange.from;
    }
    if (timeRange?.to !== undefined) {
      timeFilter += " AND a.created_at <= $to";
      params.to = timeRange.to;
    }
    if (asOf !== undefined) {
      timeFilter += " AND a.created_at <= $asOf";
      params.asOf = asOf;
    }

    const result = await g.query(
      `MATCH (a:Anchor)
       WHERE toLower(a.content) CONTAINS $query OR toLower(a.domain) CONTAINS $query${timeFilter}
       RETURN a.id AS id, a.content AS content, a.domain AS domain,
              a.weight AS weight, a.created_at AS created_at`,
      { params },
    );

    if (!result.data || result.data.length === 0) {
      return [];
    }

    return (result.data as Record<string, unknown>[]).map((row) => ({
      id: row.id as string,
      content: row.content as string,
      type: "anchor" as const,
      // Anchors rank high — base score 0.9, boosted by weight
      score: 0.9 * ((row.weight as number) || 1.0),
      source: (row.domain as string) || "anchor",
      created_at: row.created_at as number,
      connections: [],
      strategies: new Set(["anchor"]),
    }));
  } catch {
    return [];
  }
}

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

/**
 * Recall — multi-strategy retrieval from the Brain.
 *
 * @param query     - Natural language query string
 * @param scope     - Optional scope filter (reserved for future use)
 * @param timeRange - Optional temporal filter { from?: epochMs, to?: epochMs }
 * @param asOf      - Point-in-time query: only return content that existed at this epoch ms.
 *                    Implemented as an additional upper-bound on Thought.created_at and
 *                    Episode.event_at (for temporal strategy). Chronos-inspired.
 * @param intent    - Query intent hint. Shapes which strategies run and how results are ranked:
 *                    'when' → Episode-first temporal search, sorted by event_at
 *                    'who'  → entity subgraph traversal (boosts graph results)
 *                    'why'  → causal traversal (boosts graph results)
 *                    'what' | 'how' → default semantic + graph behavior
 */
export async function recall(
  query: string,
  scope?: string,
  timeRange?: TimeRange,
  asOf?: number,
  intent?: RecallIntent,
): Promise<RecallResponse> {
  // Intent='when': run temporal Episode search alongside standard strategies.
  // Other intents use standard strategies but with score adjustments below.
  const useTemporalStrategy = intent === "when";

  // Run strategies in parallel based on intent
  const [semanticResults, graphResults, anchorResults, temporalResults] =
    await Promise.all([
      semanticSearch(query),
      graphSearch(query, timeRange, asOf),
      anchorSearch(query, timeRange, asOf),
      useTemporalStrategy ? temporalSearch(query, asOf) : Promise.resolve([] as IntermediateResult[]),
    ]);

  // Post-filter semantic results by asOf (vector search doesn't support pre-filtering)
  const filteredSemanticResults = asOf !== undefined
    ? semanticResults.filter((r) => r.created_at <= asOf)
    : semanticResults;

  // Apply intent-based score adjustments
  if (intent === "who" || intent === "why") {
    // Boost graph results for entity/causal queries; they surface entity connections
    for (const r of graphResults) r.score = Math.min(1.0, r.score + 0.1);
  }

  // Track which strategies returned results
  const strategiesUsed: string[] = [];
  if (filteredSemanticResults.length > 0) strategiesUsed.push("semantic");
  if (graphResults.length > 0) strategiesUsed.push("graph");
  if (anchorResults.length > 0) strategiesUsed.push("anchor");
  if (temporalResults.length > 0) strategiesUsed.push("temporal");

  // Merge into a Map by ID (deduplicate)
  const merged = new Map<string, IntermediateResult>();

  for (const resultSet of [filteredSemanticResults, graphResults, anchorResults, temporalResults]) {
    for (const r of resultSet) {
      const existing = merged.get(r.id);
      if (existing) {
        // Boost score when found by multiple strategies
        existing.score = Math.min(1.0, existing.score + 0.15);
        // Merge strategy sets
        for (const s of r.strategies) {
          existing.strategies.add(s);
        }
        // Merge connections
        for (const c of r.connections) {
          if (!existing.connections.includes(c)) {
            existing.connections.push(c);
          }
        }
      } else {
        merged.set(r.id, { ...r });
      }
    }
  }

  // Sort by score descending
  const sorted = Array.from(merged.values()).sort(
    (a, b) => b.score - a.score,
  );

  // Enrich top results (up to 10) with provenance
  const topResults = sorted.slice(0, 10);
  const provenanceResults = await Promise.all(
    topResults.map((r) => enrichWithProvenance(r)),
  );

  // Build final RecallResult array
  const results: RecallResult[] = topResults.map((r, i) => ({
    id: r.id,
    content: r.content,
    type: r.type,
    score: Math.round(r.score * 1000) / 1000, // 3 decimal places
    source: r.source,
    created_at: r.created_at,
    connections: r.connections,
    provenance: provenanceResults[i],
  }));

  return {
    results,
    query,
    strategies_used: strategiesUsed,
    ...(asOf !== undefined && { as_of: asOf }),
    ...(intent !== undefined && { intent }),
  };
}
