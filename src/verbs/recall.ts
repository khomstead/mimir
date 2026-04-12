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

import { getGraph, vectorSearch } from "../graph.js";
import { generateEmbedding } from "../embeddings.js";
import type { RecallResult, RecallResponse } from "../types.js";

interface TimeRange {
  from?: number;
  to?: number;
}

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
 */
async function graphSearch(
  query: string,
  timeRange?: TimeRange,
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
 * Strategy 3: Anchor search.
 * Finds Anchors whose content or domain matches the query.
 * Anchors always rank high (they're foundational).
 */
async function anchorSearch(
  query: string,
  timeRange?: TimeRange,
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
 * Enrich a result with provenance — which Episode it came from.
 */
async function enrichWithProvenance(
  result: IntermediateResult,
): Promise<string | null> {
  if (result.type !== "thought") return null;

  try {
    const g = getGraph();
    const epResult = await g.query(
      `MATCH (t:Thought {id: $id})-[:extracted_from]->(ep:Episode)
       RETURN ep.content AS content, ep.source_type AS source_type
       LIMIT 1`,
      { params: { id: result.id } },
    );

    if (epResult.data && epResult.data.length > 0) {
      const row = epResult.data[0] as Record<string, unknown>;
      const sourceType = row.source_type as string;
      const content = (row.content as string)?.slice(0, 80);
      return `${sourceType}: ${content}`;
    }
  } catch {
    // Non-fatal
  }
  return null;
}

/**
 * Recall — multi-strategy retrieval from the Brain.
 *
 * @param query - Natural language query string
 * @param scope - Optional scope filter (unused in MVP, reserved for future)
 * @param timeRange - Optional temporal filter { from?: epochMs, to?: epochMs }
 */
export async function recall(
  query: string,
  scope?: string,
  timeRange?: TimeRange,
): Promise<RecallResponse> {
  // Run all three strategies in parallel
  const [semanticResults, graphResults, anchorResults] = await Promise.all([
    semanticSearch(query),
    graphSearch(query, timeRange),
    anchorSearch(query, timeRange),
  ]);

  // Track which strategies returned results
  const strategiesUsed: string[] = [];
  if (semanticResults.length > 0) strategiesUsed.push("semantic");
  if (graphResults.length > 0) strategiesUsed.push("graph");
  if (anchorResults.length > 0) strategiesUsed.push("anchor");

  // Merge into a Map by ID (deduplicate)
  const merged = new Map<string, IntermediateResult>();

  for (const resultSet of [semanticResults, graphResults, anchorResults]) {
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
  };
}
