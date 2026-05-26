/**
 * Mimir — Explain Episode Verb (Phase B2 of memory-hover-indicator sprint).
 *
 * Returns the entities + connections + crosslinks Mimir extracted from a
 * single Episode. Powers Observatory's "Show what Mosscap learned" reveal
 * on the memory gutter popover — a transparency affordance that makes the
 * graph layer legible to end users without requiring a separate UI surface.
 *
 * Three queries, all tenant-filtered:
 *
 *   1. Episode existence + ownership. If the caller can't see the
 *      episode (different tenant, no folio overlap), return target_type:
 *      "not_found" so the proxy can refuse without leaking existence.
 *
 *   2. Entities the episode `involves`. Each Episode connects to N
 *      Entities via an `:involves` edge — these are the nouns the
 *      extraction pass found in the content.
 *
 *   3. Fact edges between those entities whose `source_episode_id`
 *      matches the queried episode. These are the relationships the
 *      extraction inferred — "Day of AI REACHES 2 million students."
 *
 *   4. Crosslinks: edges from the extracted entities to PRE-EXISTING
 *      entities (older episodes' nodes) via evolves/supersedes/related.
 *      These tell the user "this builds on something Mosscap already
 *      knew" rather than presenting the memory as isolated.
 *
 * Tenant safety: every query AND-joins the `applyTenantFilter` predicate.
 * A cross-tenant probe (caller A asking about caller B's episode) hits the
 * step 1 not-found case and exits. Even if step 1 somehow passed (e.g.
 * folio-shared Episode), steps 2-4 ALSO apply the predicate to entities +
 * fact-edges, so we cannot leak relationship structure that wasn't already
 * authorized by the share.
 */

import { applyTenantFilter, getGraph } from "../graph.js";
import type { TenantFilter } from "../types.js";

export interface ExplainEpisodeEntity {
  /** Display name of the entity (e.g. "Day of AI", "MIT RAISE"). */
  name: string;
  /** Kind hint for UI styling (org/person/concept/etc.). */
  type: string;
}

export interface ExplainEpisodeEdge {
  /** Source entity name. */
  from: string;
  /** Target entity name. */
  to: string;
  /** Edge type token (REACHES, PRODUCED_BY, evolves, etc.). */
  relation: string;
  /** Human-readable fact summary if the edge carries one (Graphiti pattern). */
  fact: string | null;
}

export interface ExplainEpisodeCrosslink {
  /** Name of the pre-existing entity (from an older episode) this links to. */
  existingNode: string;
  /** Relationship token (evolves/supersedes/related). */
  relation: string;
}

export interface ExplainEpisodeResponse {
  episodeId: string;
  /** "found" when the caller has access; "not_found" for missing/cross-tenant. */
  status: "found" | "not_found";
  entities: ExplainEpisodeEntity[];
  edges: ExplainEpisodeEdge[];
  crosslinks: ExplainEpisodeCrosslink[];
}

/**
 * Extract entities + fact-edges + crosslinks for a single episode, scoped
 * to the caller's tenant. Returns `status: "not_found"` for missing or
 * cross-tenant episode ids — callers should treat both the same.
 *
 * Throws ONLY on a missing TenantFilter — that's a structural caller-bug
 * (the service layer's extractTenantFilter would have already 401'd) and
 * should never reach this function in production.
 */
export async function explainEpisode(
  episodeId: string,
  filter: TenantFilter,
): Promise<ExplainEpisodeResponse> {
  if (!filter || !filter.callerUserId) {
    throw new Error(
      "explainEpisode: TenantFilter with callerUserId is required (Phase 1E).",
    );
  }
  if (!episodeId) {
    return {
      episodeId: "",
      status: "not_found",
      entities: [],
      edges: [],
      crosslinks: [],
    };
  }

  const g = getGraph();

  // ── Step 1: confirm the episode is visible to the caller ────────────────
  const epFilter = applyTenantFilter("ep", filter, "tep");
  const epResult = await g.query(
    `MATCH (ep:Episode {id: $epId})
     WHERE ${epFilter.fragment}
     RETURN ep.id AS id LIMIT 1`,
    { params: { epId: episodeId, ...epFilter.params } },
  );
  if (!epResult.data || epResult.data.length === 0) {
    return {
      episodeId,
      status: "not_found",
      entities: [],
      edges: [],
      crosslinks: [],
    };
  }

  // ── Step 2: entities the episode `involves` ─────────────────────────────
  // Strict per-tenant on the Entity too: every user gets their own copy
  // of common entities (Phase 1E strict isolation, see graph.ts), so this
  // returns only the caller's view of the relationships.
  const entityFilter = applyTenantFilter("e", filter, "tee");
  const entityResult = await g.query(
    `MATCH (ep:Episode {id: $epId})-[:involves]->(e:Entity)
     WHERE ${entityFilter.fragment}
     RETURN e.id AS id, e.name AS name, e.type AS type
     ORDER BY e.name`,
    { params: { epId: episodeId, ...entityFilter.params } },
  );
  const entities: ExplainEpisodeEntity[] = [];
  const entityIds = new Set<string>();
  const entityNamesById = new Map<string, string>();
  if (entityResult.data) {
    for (const row of entityResult.data as Record<string, unknown>[]) {
      const id = row.id as string;
      const name = row.name as string;
      const type = (row.type as string) ?? "concept";
      entities.push({ name, type });
      entityIds.add(id);
      entityNamesById.set(id, name);
    }
  }

  // ── Step 3: fact-edges among those entities, sourced from THIS episode ──
  // We accept edges where source_episode_id matches OR the edge appears in
  // the episode_ids[] provenance list (Graphiti dedup pattern carries multi-
  // episode evidence). belief_state filter drops retracted/weakened facts so
  // the user sees only the still-valid extraction product.
  const factFilter = applyTenantFilter("r", filter, "ter");
  const factResult = await g.query(
    `MATCH (a:Entity)-[r]->(b:Entity)
     WHERE (r.source_episode_id = $epId
            OR (r.episode_ids IS NOT NULL AND $epId IN r.episode_ids))
       AND r.fact IS NOT NULL
       AND (r.belief_state IS NULL OR r.belief_state IN ['asserted', 'confirmed'])
       AND ${factFilter.fragment}
     RETURN a.name AS from_name, b.name AS to_name,
            type(r) AS relation, r.fact AS fact
     LIMIT 50`,
    { params: { epId: episodeId, ...factFilter.params } },
  );
  const edges: ExplainEpisodeEdge[] = [];
  if (factResult.data) {
    for (const row of factResult.data as Record<string, unknown>[]) {
      edges.push({
        from: row.from_name as string,
        to: row.to_name as string,
        relation: (row.relation as string) ?? "related",
        fact: (row.fact as string) ?? null,
      });
    }
  }

  // ── Step 4: crosslinks to pre-existing nodes ────────────────────────────
  // Find evolves/supersedes/related edges from the episode's entities to
  // OTHER entities (older nodes that this memory builds on). Skip
  // self-references — those are already covered by the fact-edge query.
  // Tenant filter on the target entity too — never leak structure across
  // tenants even if a cross-tenant entity name overlap exists.
  const crosslinks: ExplainEpisodeCrosslink[] = [];
  if (entityIds.size > 0) {
    const xLinkFilter = applyTenantFilter("other", filter, "tex");
    const xResult = await g.query(
      `MATCH (e:Entity)-[r]->(other:Entity)
       WHERE e.id IN $entityIds
         AND type(r) IN ['evolves', 'supersedes', 'related']
         AND NOT other.id IN $entityIds
         AND ${xLinkFilter.fragment}
       RETURN other.name AS name, type(r) AS relation
       LIMIT 20`,
      {
        params: {
          entityIds: Array.from(entityIds),
          ...xLinkFilter.params,
        },
      },
    );
    if (xResult.data) {
      const seen = new Set<string>();
      for (const row of xResult.data as Record<string, unknown>[]) {
        const name = row.name as string;
        const relation = (row.relation as string) ?? "related";
        const key = `${relation}:${name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        crosslinks.push({ existingNode: name, relation });
      }
    }
  }

  return {
    episodeId,
    status: "found",
    entities,
    edges,
    crosslinks,
  };
}
