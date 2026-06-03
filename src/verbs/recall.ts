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

import { getGraph, vectorSearch, hydrateNode, applyTenantFilter } from "../graph.js";
import { generateEmbedding } from "../embeddings.js";
import type { RecallResult, RecallResponse, RecallOrigin, TenantFilter } from "../types.js";

interface TimeRange {
  from?: number;
  to?: number;
}

/** Intent hint shapes which retrieval strategies run and how results are ranked. */
type RecallIntent = "when" | "who" | "why" | "what" | "how";

/** Tenant stamps carried alongside each result for soft-bias + provenance. */
interface NodeStamps {
  ownerUserId?: string;
  orgId?: string;
  folioIds?: string[];
  orgCanon?: boolean;
}

interface IntermediateResult extends NodeStamps {
  id: string;
  content: string;
  type: RecallResult["type"];
  score: number;
  source: string;
  created_at: number;
  connections: string[];
  strategies: Set<string>;
}

// Soft-bias boosts (Knowledge Architecture P1, grilled Q2). Foreground
// curated canon strongest, then the active workspace; personal + plain
// shared content keep their baseline so they still surface (not a firewall).
const ORG_CANON_BOOST = 0.25;
const WORKSPACE_BOOST = 0.15;

/**
 * Compute the provenance origin of a result from its tenant stamps + the
 * caller's filter. Trust comes from visible sourcing (grilled Q2). The
 * tier precedence is canon > workspace > shared > personal.
 */
function computeOrigin(node: NodeStamps, filter: TenantFilter): RecallOrigin {
  const activeFolios = filter.activeFolioIds ?? [];
  const isOrgCanon =
    !!filter.activeOrgScope &&
    node.orgId === filter.activeOrgScope &&
    node.orgCanon === true;
  if (isOrgCanon) {
    return {
      tier: "org_canon",
      label: filter.activeOrgName ? `${filter.activeOrgName} canon` : "Org canon",
      orgId: node.orgId,
      folioIds: node.folioIds,
    };
  }
  const inActiveWorkspace =
    activeFolios.length > 0 &&
    (node.folioIds ?? []).some((f) => activeFolios.includes(f));
  if (inActiveWorkspace) {
    return { tier: "workspace", label: "This workspace", folioIds: node.folioIds };
  }
  // Owned by the caller with no shared scope → their own personal note.
  if (node.ownerUserId && node.ownerUserId === filter.callerUserId) {
    return { tier: "personal", label: "Your personal note" };
  }
  // Visible via folio share but not the active workspace.
  return { tier: "shared", label: "Shared with you", folioIds: node.folioIds };
}

/** Score adjustment a given origin earns (soft-bias foregrounding). */
function originBoost(origin: RecallOrigin): number {
  if (origin.tier === "org_canon") return ORG_CANON_BOOST;
  if (origin.tier === "workspace") return WORKSPACE_BOOST;
  return 0;
}

/**
 * Strategy 1: Semantic vector search — tenant-scoped (Phase 1E).
 * Generate an embedding for the query and find similar Thoughts.
 */
async function semanticSearch(
  query: string,
  filter: TenantFilter,
): Promise<IntermediateResult[]> {
  // FAIL LOUD: embedder errors used to be swallowed by a bare catch → semantic
  // search silently returned nothing for weeks. A dead embedder is now logged,
  // not hidden.
  let queryEmbedding: number[];
  try {
    queryEmbedding = await generateEmbedding(query);
  } catch (err) {
    console.error(
      `[mimir:recall] semantic search DISABLED — embedder error: ${(err as Error).message}`,
    );
    return [];
  }

  let results: Awaited<ReturnType<typeof vectorSearch>>;
  try {
    results = await vectorSearch(queryEmbedding, 10, filter);
  } catch (err) {
    // Vector search may legitimately fail if no Thought nodes exist yet, but it
    // can also mask a real index/dimension problem — surface it.
    console.error(
      `[mimir:recall] vectorSearch failed: ${(err as Error).message}`,
    );
    return [];
  }

  const mapped: IntermediateResult[] = [];
  for (const r of results) {
    // A non-finite cosine distance means a degenerate stored vector — almost
    // always a node that hasn't been re-embedded yet (legacy zero vector).
    // Do NOT fake a 0.5 score; log the degraded node and exclude it from ranking.
    if (!Number.isFinite(r.score)) {
      console.error(
        `[mimir:recall] degraded: non-finite distance for thought ${r.id} ` +
          `(likely an un-backfilled zero vector) — excluding from results`,
      );
      continue;
    }
    mapped.push({
      id: r.id,
      content: r.content,
      type: "thought" as const,
      // FalkorDB cosine returns a distance; similarity = 1 - distance.
      score: 1 - r.score,
      source: "semantic",
      created_at: r.created_at,
      connections: [],
      strategies: new Set(["semantic"]),
      ownerUserId: r.tenant_user_id,
      orgId: r.tenant_org_id,
      folioIds: r.folio_ids,
      orgCanon: r.org_canon,
    });
  }
  return mapped;
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
  filter: TenantFilter,
  timeRange?: TimeRange,
  asOf?: number,
): Promise<IntermediateResult[]> {
  try {
    const g = getGraph();

    const { fragment: tenantFragment, params: tenantParams } = applyTenantFilter(
      "t",
      filter,
    );
    let timeFilter = "";
    const params: Record<string, unknown> = {
      query: query.toLowerCase(),
      ...tenantParams,
    };

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
       WHERE toLower(t.content) CONTAINS $query
         AND ${tenantFragment}${timeFilter}
       OPTIONAL MATCH (t)-[]->(e:Entity)
       RETURN t.id AS id, t.content AS content, t.created_at AS created_at,
              t.tenant_user_id AS tenant_user_id, t.tenant_org_id AS tenant_org_id,
              t.folio_ids AS folio_ids, t.org_canon AS org_canon,
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
      ownerUserId: row.tenant_user_id as string | undefined,
      orgId: row.tenant_org_id as string | undefined,
      folioIds: (row.folio_ids as string[] | undefined) ?? undefined,
      orgCanon: row.org_canon === true,
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
  filter: TenantFilter,
  asOf?: number,
): Promise<IntermediateResult[]> {
  try {
    const g = getGraph();

    const { fragment: tenantFragment, params: tenantParams } = applyTenantFilter(
      "ep",
      filter,
    );
    const params: Record<string, unknown> = {
      query: query.toLowerCase(),
      ...tenantParams,
    };
    let asOfFilter = "";
    if (asOf !== undefined) {
      asOfFilter = " AND ep.event_at <= $asOf";
      params.asOf = asOf;
    }

    // Find Episodes whose content matches the query, filtered by event_at AND tenant.
    const result = await g.query(
      `MATCH (ep:Episode)
       WHERE toLower(ep.content) CONTAINS $query
         AND ${tenantFragment}${asOfFilter}
       OPTIONAL MATCH (t:Thought)-[:extracted_from]->(ep)
       RETURN ep.id AS ep_id, ep.content AS ep_content,
              ep.event_at AS event_at, ep.timestamp AS ingested_at,
              t.id AS thought_id, t.content AS thought_content,
              t.created_at AS thought_created_at,
              t.tenant_user_id AS tenant_user_id, t.tenant_org_id AS tenant_org_id,
              t.folio_ids AS folio_ids, t.org_canon AS org_canon
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
        ownerUserId: row.tenant_user_id as string | undefined,
        orgId: row.tenant_org_id as string | undefined,
        folioIds: (row.folio_ids as string[] | undefined) ?? undefined,
        orgCanon: row.org_canon === true,
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
  filter: TenantFilter,
  timeRange?: TimeRange,
  asOf?: number,
): Promise<IntermediateResult[]> {
  try {
    const g = getGraph();

    const { fragment: tenantFragment, params: tenantParams } = applyTenantFilter(
      "a",
      filter,
    );
    let timeFilter = "";
    const params: Record<string, unknown> = {
      query: query.toLowerCase(),
      ...tenantParams,
    };

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
       WHERE (toLower(a.content) CONTAINS $query OR toLower(a.domain) CONTAINS $query)
         AND ${tenantFragment}${timeFilter}
       RETURN a.id AS id, a.content AS content, a.domain AS domain,
              a.weight AS weight, a.created_at AS created_at,
              a.tenant_user_id AS tenant_user_id, a.tenant_org_id AS tenant_org_id,
              a.folio_ids AS folio_ids, a.org_canon AS org_canon`,
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
      ownerUserId: row.tenant_user_id as string | undefined,
      orgId: row.tenant_org_id as string | undefined,
      folioIds: (row.folio_ids as string[] | undefined) ?? undefined,
      orgCanon: row.org_canon === true,
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
  filter: TenantFilter,
): Promise<string | null> {
  if (result.type !== "thought") return null;

  const hydrated = await hydrateNode(result.id, "Thought", filter);
  if (hydrated) {
    return `${hydrated.source_type}: ${hydrated.content}`;
  }
  return null;
}

/**
 * Recall — multi-strategy retrieval from the Brain.
 *
 * Phase 1E: recall is tenant-scoped. The `filter` parameter is required;
 * a missing or invalid `callerUserId` throws at the strategy layer
 * (fail-closed — no anonymous reads).
 *
 * @param query     - Natural language query string
 * @param filter    - TenantFilter — caller's userId + folio access + org scope
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
  filter: TenantFilter,
  scope?: string,
  timeRange?: TimeRange,
  asOf?: number,
  intent?: RecallIntent,
): Promise<RecallResponse> {
  if (!filter || !filter.callerUserId) {
    throw new Error(
      "recall: TenantFilter with callerUserId is required (Phase 1E).",
    );
  }
  // Intent='when': run temporal Episode search alongside standard strategies.
  // Other intents use standard strategies but with score adjustments below.
  const useTemporalStrategy = intent === "when";

  // Run strategies in parallel based on intent — all four scoped by tenant.
  const [semanticResults, graphResults, anchorResults, temporalResults] =
    await Promise.all([
      semanticSearch(query, filter),
      graphSearch(query, filter, timeRange, asOf),
      anchorSearch(query, filter, timeRange, asOf),
      useTemporalStrategy ? temporalSearch(query, filter, asOf) : Promise.resolve([] as IntermediateResult[]),
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

  // Soft-bias foregrounding (Knowledge Architecture P1, grilled Q2): compute
  // each result's provenance origin, then boost org-canon + active-workspace
  // results so they rank higher WITHOUT excluding personal/shared content.
  // Trust comes from the visible label, not from caging the other tiers.
  const withOrigin = Array.from(merged.values()).map((r) => {
    const origin = computeOrigin(r, filter);
    return {
      ...r,
      origin,
      score: Math.min(1.0, r.score + originBoost(origin)),
    };
  });

  // Sort by (boosted) score descending
  const sorted = withOrigin.sort((a, b) => b.score - a.score);

  // Enrich top results (up to 10) with provenance — tenant-scoped hydration.
  const topResults = sorted.slice(0, 10);
  const provenanceResults = await Promise.all(
    topResults.map((r) => enrichWithProvenance(r, filter)),
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
    origin: r.origin,
  }));

  return {
    results,
    query,
    strategies_used: strategiesUsed,
    ...(asOf !== undefined && { as_of: asOf }),
    ...(intent !== undefined && { intent }),
  };
}
