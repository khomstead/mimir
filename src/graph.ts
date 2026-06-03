/**
 * Mimir — FalkorDBLite Graph Layer
 *
 * Manages the persistent graph database connection, schema creation,
 * and core graph operations (node/edge CRUD, vector search).
 *
 * Phase 1E (Multi-tenancy):
 * Every Episode, Thought, Entity, and Anchor is stamped with a
 * `tenant_user_id` (required) + optional `tenant_org_id` + optional
 * `folio_ids` array. Recall/find/hydrate queries are scoped at the
 * Cypher WHERE-clause level using `applyTenantFilter()`.
 *
 * Security invariant: the leftmost predicate of every read path is the
 * tenant filter. A confused-deputy request can never return another
 * user's content because the filter is structural, not an app-layer
 * post-filter. Writes without a tenant stamp throw — there is no
 * silent default-to-Kyle fallback at the graph layer.
 *
 * Sharing model: READ-PREDICATE (not clone). Episodes/Thoughts live
 * in the retainer's tenant and are surfaced cross-boundary via
 * `folio_ids ∩ includeFolioIds`. Entities and fact-edges remain
 * strictly per-tenant — every user gets their own "Kyle Homstead"
 * entity, never shared. See mimir/CLAUDE.md "Multi-Tenancy".
 */

import { FalkorDB } from "falkordblite";
import type { Graph } from "falkordb";
import type { EdgeType, BeliefState, TenantStamp, TenantFilter } from "./types.js";
import { EMBEDDING_DIM } from "./embeddings.js";

/**
 * Source authority scores — used for contradiction resolution.
 * Higher authority wins when two facts conflict.
 * Derived from Pith + Mem0 authority-weighted belief revision.
 */
export const SOURCE_AUTHORITY: Record<string, number> = {
  voice: 0.9,       // user-spoken directly to Mosscap
  manual: 0.85,     // user-typed directly
  chat: 0.85,       // Observatory text chat
  meeting: 0.8,     // meeting notes
  email: 0.7,       // secondhand / forwarded info
  distillation: 0.5, // LLM distillation pass
};
/** Fallback authority when source type isn't in the mapping (e.g. background extraction). */
export const DEFAULT_AUTHORITY = 0.6;

let db: FalkorDB | null = null;
let graph: Graph | null = null;

/**
 * Initialize FalkorDBLite with persistent storage and create schema indexes.
 * REQUIRES an explicit dataPath — no default fallback to prevent accidental
 * cross-Brain data writes in the federated model.
 */
export async function initGraph(dataPath: string): Promise<Graph> {
  if (!dataPath) {
    throw new Error(
      "initGraph requires an explicit dataPath. " +
        "No default path is allowed to prevent cross-Brain data writes."
    );
  }

  db = await FalkorDB.open({ path: dataPath });
  graph = db.selectGraph("mimir");

  // Create indexes idempotently
  await graph
    .query("CREATE INDEX FOR (e:Entity) ON (e.name)")
    .catch(() => {});
  await graph
    .query("CREATE INDEX FOR (t:Thought) ON (t.created_at)")
    .catch(() => {});
  await graph
    .query("CREATE INDEX FOR (a:Anchor) ON (a.domain)")
    .catch(() => {});
  await graph
    .query("CREATE INDEX FOR (ep:Episode) ON (ep.timestamp)")
    .catch(() => {});
  await graph
    .query("CREATE INDEX FOR (ep:Episode) ON (ep.event_at)")
    .catch(() => {});
  // Vector index dimension is the single source of truth in embeddings.ts
  // (EMBEDDING_DIM). Idempotent: a no-op if an index at this dimension already
  // exists. NOTE: if an index exists at a DIFFERENT dimension, this CREATE
  // silently no-ops (caught) and leaves the stale index — the dimension-migration
  // backfill (scripts/reembed-all.ts) must DROP the old index first.
  await graph
    .query(
      `CREATE VECTOR INDEX FOR (t:Thought) ON (t.embedding) OPTIONS {dimension: ${EMBEDDING_DIM}, similarityFunction: 'cosine'}`
    )
    .catch(() => {});
  // ─── Phase 1E multi-tenancy indexes ─────────────────────────
  // Per-tenant entity lookup: the strict isolation model means each user
  // has their own copy of common entities (e.g. "Kyle Homstead"). Index
  // on (tenant_user_id, name) is the lookup path used by
  // findEntityByName.
  await graph
    .query("CREATE INDEX FOR (e:Entity) ON (e.tenant_user_id, e.name)")
    .catch(() => {});
  await graph
    .query("CREATE INDEX FOR (t:Thought) ON (t.tenant_user_id, t.created_at)")
    .catch(() => {});
  await graph
    .query("CREATE INDEX FOR (ep:Episode) ON (ep.tenant_user_id, ep.timestamp)")
    .catch(() => {});
  // Composite for temporal recall strategy — `as_of` filters on event_at
  // (Pith bitemporal pattern). Without this, the tenant filter + event_at
  // upper-bound require two index scans + a join.
  await graph
    .query("CREATE INDEX FOR (ep:Episode) ON (ep.tenant_user_id, ep.event_at)")
    .catch(() => {});
  await graph
    .query("CREATE INDEX FOR (a:Anchor) ON (a.tenant_user_id, a.domain)")
    .catch(() => {});

  return graph;
}

// ─── Vector index migration helpers ─────────────────────────
// Used by scripts/reembed-all.ts to migrate the Thought.embedding vector index
// to a new dimension. The init-time CREATE above is idempotent and silently
// no-ops against a stale index of a different dimension, so a dimension change
// REQUIRES an explicit drop before re-embedding.

/**
 * Drop the Thought.embedding vector index if it exists. Idempotent — a missing
 * index is not an error. Returns true if the drop ran without throwing.
 */
export async function dropVectorIndex(): Promise<boolean> {
  const g = getGraph();
  try {
    await g.query("DROP VECTOR INDEX FOR (t:Thought) ON (t.embedding)");
    return true;
  } catch (err) {
    // FalkorDB throws if the index doesn't exist — that's a benign no-op for our
    // purposes. Surface anything unexpected for the migration operator.
    console.error(
      `[mimir:graph] dropVectorIndex: ${(err as Error).message} (ok if index was absent)`,
    );
    return false;
  }
}

/**
 * (Re)create the Thought.embedding vector index at EMBEDDING_DIM. Idempotent.
 */
export async function createVectorIndex(): Promise<void> {
  const g = getGraph();
  await g
    .query(
      `CREATE VECTOR INDEX FOR (t:Thought) ON (t.embedding) OPTIONS {dimension: ${EMBEDDING_DIM}, similarityFunction: 'cosine'}`,
    )
    .catch((err: Error) => {
      console.error(
        `[mimir:graph] createVectorIndex: ${err.message} (ok if index already exists)`,
      );
    });
}

// ─── Phase 1E: Tenant filter helpers ────────────────────────

/**
 * Build a Cypher predicate fragment that scopes a query to the caller's
 * visible content. The fragment is AND-joined into a WHERE clause along
 * with parameter values to merge into the query params.
 *
 * Visibility rules (composes as: ownership AND visibility [AND org]):
 *   - OWNERSHIP: nodes where `tenant_user_id = $callerUserId`. If
 *     `includeFolioIds` is non-empty, ALSO include nodes whose
 *     `folio_ids` array intersects with the allowed folios — this is
 *     the cross-tenant read predicate for shared content.
 *   - VISIBILITY: a node marked `tenant_invisible_after <= now` is
 *     hidden (Phase 1E forget-cascade for share revocation).
 *   - ORG SCOPE: if `activeOrgScope` is set, additionally filter to
 *     nodes whose `tenant_org_id` matches OR is null (legacy untagged).
 *
 * Param names are suffixed with a caller-supplied paramPrefix so the
 * function can be called multiple times in one query without collision
 * (e.g. one filter for Thought + one for Episode in the same recall).
 *
 * Throws if `callerUserId` is missing — there is no anonymous-read
 * fallback at the graph layer.
 */
export function applyTenantFilter(
  variable: string,
  filter: TenantFilter,
  paramPrefix: string = "tenant",
): { fragment: string; params: Record<string, unknown> } {
  if (!filter || !filter.callerUserId) {
    throw new Error(
      "applyTenantFilter: callerUserId is required (no anonymous reads — fail-closed)",
    );
  }
  const now = Date.now();
  const params: Record<string, unknown> = {
    [`${paramPrefix}_userId`]: filter.callerUserId,
    [`${paramPrefix}_now`]: now,
  };

  // Ownership clause: owner OR (folio-shared via folio_ids intersection)
  // OR (org-canon readable by an active member). These are ADDITIVE read
  // grants — each widens what the caller can see; none leaks another
  // user's private content.
  const ownershipParts = [`${variable}.tenant_user_id = $${paramPrefix}_userId`];
  if (filter.includeFolioIds && filter.includeFolioIds.length > 0) {
    params[`${paramPrefix}_folios`] = filter.includeFolioIds;
    ownershipParts.push(
      `(${variable}.folio_ids IS NOT NULL AND any(f IN ${variable}.folio_ids WHERE f IN $${paramPrefix}_folios))`,
    );
  }
  // Additive org-canon read grant (Knowledge Architecture P1, 2026-06-03):
  // when the caller asserts an active org scope (daemon resolves the
  // caller's REAL memberships before setting it — see mimir-tenant-builder),
  // org-canon nodes stamped with that org become readable even though
  // they're owned by another member. `org_canon = true` is the gate, so an
  // ordinary org-context note (tenant_org_id set, org_canon absent) does
  // NOT surface cross-member.
  if (filter.activeOrgScope) {
    params[`${paramPrefix}_orgScope`] = filter.activeOrgScope;
    ownershipParts.push(
      `(${variable}.tenant_org_id = $${paramPrefix}_orgScope AND ${variable}.org_canon = true)`,
    );
  }
  const ownershipClause =
    ownershipParts.length === 1
      ? ownershipParts[0]
      : `(${ownershipParts.join(" OR ")})`;

  // Forget-cascade visibility: a node marked tenant_invisible_after a
  // past time is invisible. Null means visible.
  const invisibilityClause = `(${variable}.tenant_invisible_after IS NULL OR ${variable}.tenant_invisible_after > $${paramPrefix}_now)`;

  // NOTE: the former restrictive org-scope clause (AND tenant_org_id =
  // orgScope OR NULL) was REMOVED in Knowledge Architecture P1. It was a
  // firewall that excluded the caller's OWN content tagged with a different
  // org — the "caged colleague" anti-pattern (grilled Q2). Org scope is now
  // a soft-bias signal (boost in the recall verb + the additive grant
  // above), never a hard exclusion. Cross-USER isolation is preserved by
  // the ownership clause; org scope only ever WIDENS visibility now.

  return {
    fragment: `(${ownershipClause}) AND ${invisibilityClause}`,
    params,
  };
}

/**
 * Phase 1E forget-cascade: when a folio share is revoked, the recipient's
 * OWN derived nodes (Episodes/Thoughts/Entities they retained that
 * reference the revoked folio via folio_ids) get
 * `tenant_invisible_after = now`. Their recall stops returning them
 * from that moment forward.
 *
 * The cross-tenant READS of the original owner's content stop
 * automatically (recipient's `includeFolioIds` no longer contains the
 * revoked folio) — that path needs no cascade.
 *
 * Idempotent: re-running with the same args is a no-op (skips already-
 * marked-invisible nodes via the `OR tenant_invisible_after > $now` check).
 *
 * The original owner's view is UNTOUCHED — Episode = ground truth,
 * never deleted, never modified by the cascade.
 *
 * Returns per-type counts for audit logging.
 */
export async function applyShareRevocationCascade(args: {
  folioId: string;
  revokedUserId: string;
}): Promise<{ episodes: number; thoughts: number; entities: number }> {
  const g = getGraph();
  if (!args.folioId || !args.revokedUserId) {
    throw new Error(
      "applyShareRevocationCascade: folioId and revokedUserId are required",
    );
  }
  const now = Date.now();

  const episodeResult = await g.query(
    `MATCH (ep:Episode)
     WHERE ep.tenant_user_id = $userId
       AND ep.folio_ids IS NOT NULL
       AND $folioId IN ep.folio_ids
       AND (ep.tenant_invisible_after IS NULL OR ep.tenant_invisible_after > $now)
     SET ep.tenant_invisible_after = $now
     RETURN count(ep) AS affected`,
    { params: { userId: args.revokedUserId, folioId: args.folioId, now } },
  );
  const episodes =
    ((episodeResult.data?.[0] as Record<string, unknown>)?.affected as number) ?? 0;

  const thoughtResult = await g.query(
    `MATCH (t:Thought)
     WHERE t.tenant_user_id = $userId
       AND t.folio_ids IS NOT NULL
       AND $folioId IN t.folio_ids
       AND (t.tenant_invisible_after IS NULL OR t.tenant_invisible_after > $now)
     SET t.tenant_invisible_after = $now
     RETURN count(t) AS affected`,
    { params: { userId: args.revokedUserId, folioId: args.folioId, now } },
  );
  const thoughts =
    ((thoughtResult.data?.[0] as Record<string, unknown>)?.affected as number) ?? 0;

  const entityResult = await g.query(
    `MATCH (e:Entity)
     WHERE e.tenant_user_id = $userId
       AND e.folio_ids IS NOT NULL
       AND $folioId IN e.folio_ids
       AND (e.tenant_invisible_after IS NULL OR e.tenant_invisible_after > $now)
     SET e.tenant_invisible_after = $now
     RETURN count(e) AS affected`,
    { params: { userId: args.revokedUserId, folioId: args.folioId, now } },
  );
  const entities =
    ((entityResult.data?.[0] as Record<string, unknown>)?.affected as number) ?? 0;

  return { episodes, thoughts, entities };
}

/**
 * Returns the active Graph instance. Throws if not initialized.
 */
export function getGraph(): Graph {
  if (!graph) {
    throw new Error("Graph not initialized. Call initGraph() first.");
  }
  return graph;
}

/**
 * Shuts down the graph database cleanly.
 */
export async function closeGraph(): Promise<void> {
  if (db) {
    await db.close();
    db = null;
    graph = null;
  }
}

/**
 * Generate a UUID v4 string.
 */
function uuid(): string {
  return crypto.randomUUID();
}

/**
 * Create a node with a given label and properties.
 * Auto-generates a UUID for the `id` field.
 * Handles vector arrays (number[]) by inlining vecf32().
 *
 * Phase 1E: a `tenant` stamp is REQUIRED for nodes that participate in
 * the multi-tenant graph (Episode, Thought, Entity, Anchor). Structural
 * nodes that aren't tenant-scoped (Meeting, Artifact) can pass
 * `tenant=null` explicitly. The default path throws if no stamp is
 * provided for a tenant-required label — preventing accidental
 * untagged writes that would be invisible after Phase 1E enforcement.
 *
 * Returns the generated UUID.
 */
export async function createNode(
  label: string,
  props: Record<string, unknown>,
  tenant?: TenantStamp | null,
): Promise<string> {
  const g = getGraph();
  const id = uuid();
  const TENANT_REQUIRED_LABELS = new Set(["Episode", "Thought", "Entity", "Anchor"]);
  if (TENANT_REQUIRED_LABELS.has(label)) {
    if (tenant === undefined) {
      throw new Error(
        `createNode: tenant stamp required for ${label} nodes (Phase 1E). ` +
        `Pass an explicit TenantStamp { userId, ... } — there is no silent default fallback.`,
      );
    }
    if (tenant !== null && !tenant.userId) {
      throw new Error(
        `createNode: TenantStamp.userId is required for ${label} nodes. ` +
        `Empty/null userId is rejected to prevent untagged writes.`,
      );
    }
  }

  // Merge tenant stamp into props if present.
  const tenantProps: Record<string, unknown> = {};
  if (tenant && tenant.userId) {
    tenantProps.tenant_user_id = tenant.userId;
    if (tenant.organizationId) tenantProps.tenant_org_id = tenant.organizationId;
    if (tenant.folioIds && tenant.folioIds.length > 0) {
      tenantProps.folio_ids = tenant.folioIds;
    }
    // Org-canon marker (Knowledge Architecture P1) — only the Convex
    // knowledge bridge sets this (entryVisibility:"org" promotions). It is
    // what flips a node from "owner-only / folio-shared" to "readable by
    // any member of tenant_org_id" via the additive grant in
    // applyTenantFilter + vectorSearch. Requires tenant_org_id to matter.
    if (tenant.orgCanon && tenant.organizationId) {
      tenantProps.org_canon = true;
    }
  }
  const allProps = { id, ...tenantProps, ...props };

  const setParts: string[] = [];
  const params: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(allProps)) {
    if (Array.isArray(value) && typeof value[0] === "number") {
      // Vector array — use vecf32() inline
      setParts.push(`n.${key} = vecf32($${key})`);
      params[key] = value;
    } else {
      setParts.push(`n.${key} = $${key}`);
      params[key] = value;
    }
  }

  const cypher = `CREATE (n:${label}) SET ${setParts.join(", ")} RETURN n.id`;
  await g.query(cypher, { params });
  return id;
}

/**
 * Create a temporally-tracked edge between two nodes.
 */
export async function createEdge(
  fromLabel: string,
  fromId: string,
  toLabel: string,
  toId: string,
  edgeType: EdgeType,
  props?: Partial<{
    created_at: number;
    valid_from: number;
    valid_until: number | null;
    confidence: number;
    source_episode_id: string | null;
  }>
): Promise<void> {
  const g = getGraph();
  const now = Date.now();

  const edgeProps = {
    type: edgeType,
    created_at: props?.created_at ?? now,
    valid_from: props?.valid_from ?? now,
    valid_until: props?.valid_until ?? null,
    confidence: props?.confidence ?? 1.0,
    source_episode_id: props?.source_episode_id ?? null,
  };

  const cypher = `
    MATCH (a:${fromLabel} {id: $fromId}), (b:${toLabel} {id: $toId})
    CREATE (a)-[r:${edgeType} {
      type: $type,
      created_at: $created_at,
      valid_from: $valid_from,
      valid_until: $valid_until,
      confidence: $confidence,
      source_episode_id: $source_episode_id
    }]->(b)
    RETURN r
  `;

  await g.query(cypher, {
    params: {
      fromId,
      toId,
      ...edgeProps,
    },
  });
}

/**
 * Find an entity by name (case-insensitive), scoped to the caller's tenant.
 * Searches both the `name` property and the `synonyms` array.
 *
 * Phase 1E: strict per-tenant entity isolation. Each user gets their
 * own "Kyle Homstead" entity node. `findEntityByName(name, filter)`
 * returns the caller's copy (or a shared-via-folio copy if folio access
 * applies). It will NEVER return another user's private entity.
 *
 * The audit synthesis confirmed this strict-isolation strategy:
 *   - Pros: clean cross-user INVALIDATE = downgrade-only (entity ID
 *     space is partitioned per user; structurally impossible to mutate
 *     another user's view)
 *   - Cons: ~30x entity duplication at Lighthouse-school scale. Tracked
 *     as a Phase 1G dependency (per-org entity dedup).
 */
export async function findEntityByName(
  name: string,
  filter: TenantFilter,
): Promise<{ id: string; name: string; type: string; summary: string; tenant_user_id: string } | null> {
  const g = getGraph();

  if (!filter || !filter.callerUserId) {
    throw new Error(
      "findEntityByName: TenantFilter with callerUserId is required (Phase 1E). " +
      "Anonymous global lookup is rejected as a cross-tenant leak risk.",
    );
  }

  const { fragment, params: tenantParams } = applyTenantFilter("e", filter);
  // Search by name OR check if any synonym matches (case-insensitive)
  const result = await g.query(
    `MATCH (e:Entity)
     WHERE (toLower(e.name) = toLower($name)
        OR any(s IN e.synonyms WHERE toLower(s) = toLower($name)))
       AND ${fragment}
     RETURN e.id AS id, e.name AS name, e.type AS type, e.summary AS summary,
            e.tenant_user_id AS tenant_user_id
     LIMIT 1`,
    { params: { name, ...tenantParams } }
  );

  if (result.data && result.data.length > 0) {
    const row = result.data[0] as Record<string, unknown>;
    return {
      id: row.id as string,
      name: row.name as string,
      type: row.type as string,
      summary: row.summary as string,
      tenant_user_id: row.tenant_user_id as string,
    };
  }

  return null;
}

/**
 * Vector similarity search over Thought nodes, scoped to the caller's tenant.
 *
 * Phase 1E: FalkorDBLite's `db.idx.vector.queryNodes` doesn't support
 * pre-filter WHERE clauses inside the index call, so we OVER-FETCH
 * (k * 4 candidates) and post-filter by tenant. The audit synthesis
 * explicitly accepts this tradeoff at Catherine pilot + Lighthouse
 * 30-user scale. Phase 1I may revisit if a hotspot emerges.
 *
 * Filter semantics match `applyTenantFilter`:
 *   - Owner (caller's userId) OR folio-shared (folio_ids ∩ includeFolioIds)
 *   - Not tenant_invisible_after a past time (forget-cascade respected)
 *   - Org scope honored if `activeOrgScope` set
 *
 * Untagged legacy nodes (no tenant_user_id) are SKIPPED — Phase 1E
 * expects the backfill migration to have stamped all legacy nodes
 * with Kyle's userId before recall flows hit. A missing stamp means
 * "uninitialized" and conservatively reads as invisible.
 */
export async function vectorSearch(
  queryEmbedding: number[],
  k: number,
  filter: TenantFilter,
): Promise<Array<{
  id: string;
  content: string;
  score: number;
  created_at: number;
  tenant_user_id?: string;
  tenant_org_id?: string;
  folio_ids?: string[];
  org_canon?: boolean;
}>> {
  const g = getGraph();

  if (!filter || !filter.callerUserId) {
    throw new Error(
      "vectorSearch: TenantFilter with callerUserId is required (Phase 1E).",
    );
  }

  // Over-fetch generously. TWO reasons compound:
  //  1. HNSW recall: FalkorDB's vector index is approximate — the search breadth
  //     (ef) scales with the requested count. Heavily-duplicated content forms
  //     dense clusters that trap a small-k traversal in a local minimum, so it
  //     misses the TRUE nearest neighbours. Empirically (3784-node graph), k=40
  //     returned a wrong top set (min distance 0.335) while k≥100 found the real
  //     nearest (0.271). A small over-fetch silently degrades ranking quality.
  //  2. Tenant filtering happens AFTER the index call (db.idx.vector.queryNodes
  //     has no pre-filter), so the caller's relevant nodes can sit past a small
  //     candidate window when other tenants' content crowds the top.
  // Cost is negligible at this scale (k=1000 ≈ 15ms), and the cap bounds it as
  // the graph grows. Take top-k AFTER tenant filtering below.
  const overFetchK = Math.min(Math.max(k * 20, 256), 1000);
  const allowedFolios = filter.includeFolioIds ?? [];
  const orgScope = filter.activeOrgScope ?? null;
  const now = Date.now();

  const result = await g.query(
    `CALL db.idx.vector.queryNodes('Thought', 'embedding', $k, vecf32($embedding))
     YIELD node, score
     RETURN node.id AS id, node.content AS content, score,
            node.created_at AS created_at,
            node.tenant_user_id AS tenant_user_id,
            node.tenant_org_id AS tenant_org_id,
            node.folio_ids AS folio_ids,
            node.org_canon AS org_canon,
            node.tenant_invisible_after AS tenant_invisible_after
     ORDER BY score ASC`,
    { params: { k: overFetchK, embedding: queryEmbedding } }
  );

  if (!result.data || result.data.length === 0) {
    return [];
  }

  const filtered: Array<{
    id: string;
    content: string;
    score: number;
    created_at: number;
    tenant_user_id?: string;
    tenant_org_id?: string;
    folio_ids?: string[];
    org_canon?: boolean;
  }> = [];
  for (const r of result.data as Record<string, unknown>[]) {
    const ownerUserId = r.tenant_user_id as string | undefined;
    const folioIds = (r.folio_ids as string[] | undefined) ?? [];
    const orgId = r.tenant_org_id as string | undefined;
    const orgCanon = r.org_canon === true;
    const invisibleAfter = r.tenant_invisible_after as number | undefined;
    // Reject untagged legacy nodes — Phase 1E expects backfill before recall flows.
    if (!ownerUserId) continue;
    // Forget-cascade: skip nodes marked invisible.
    if (invisibleAfter !== undefined && invisibleAfter !== null && invisibleAfter <= now) {
      continue;
    }
    // Additive read grants (must mirror applyTenantFilter): caller owns it,
    // OR has folio access, OR it's org-canon for the caller's active org.
    // Knowledge Architecture P1 (2026-06-03): the former restrictive
    // org-firewall (`orgScope && orgId !== orgScope → exclude`) was removed
    // — org scope only WIDENS now; cross-user isolation stays on ownership.
    const ownedByCaller = ownerUserId === filter.callerUserId;
    const folioShared =
      allowedFolios.length > 0 &&
      folioIds.some((f) => allowedFolios.includes(f));
    const orgCanonReadable = !!orgScope && orgId === orgScope && orgCanon;
    if (!ownedByCaller && !folioShared && !orgCanonReadable) continue;
    filtered.push({
      id: r.id as string,
      content: r.content as string,
      score: r.score as number,
      created_at: r.created_at as number,
      tenant_user_id: ownerUserId,
      tenant_org_id: orgId,
      folio_ids: folioIds,
      org_canon: orgCanon,
    });
    if (filtered.length >= k) break;
  }

  return filtered;
}

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
  filter: TenantFilter,
): Promise<{ episodeId: string; content: string; source_type: string } | null> {
  const g = getGraph();

  if (!filter || !filter.callerUserId) {
    throw new Error(
      "hydrateNode: TenantFilter with callerUserId is required (Phase 1E).",
    );
  }

  // Phase 1E: tenant filter on the source Episode. Recursive Hydration
  // respects boundaries — a caller cannot follow an edge to an Episode
  // owned by another user (unless folio-shared). Belt-and-suspenders
  // alongside the caller-side filter on Thought/Entity.
  const { fragment, params: tenantParams } = applyTenantFilter("ep", filter);

  let cypher: string;
  if (nodeLabel === "Thought") {
    // Thought -[extracted_from]-> Episode
    cypher = `
      MATCH (t:Thought {id: $id})-[:extracted_from]->(ep:Episode)
      WHERE ${fragment}
      RETURN ep.id AS episodeId, ep.content AS content, ep.source_type AS source_type
      LIMIT 1`;
  } else {
    // Entity <-[involves]- Episode (reverse direction)
    cypher = `
      MATCH (e:Entity {id: $id})<-[:involves]-(ep:Episode)
      WHERE ${fragment}
      RETURN ep.id AS episodeId, ep.content AS content, ep.source_type AS source_type
      ORDER BY ep.timestamp DESC
      LIMIT 1`;
  }

  try {
    const result = await g.query(cypher, { params: { id: nodeId, ...tenantParams } });
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

/**
 * Update an entity's summary by merging new information via LLM.
 * Ported from Mem0's UPDATE pattern — the LLM sees the old summary
 * and the new episode context, then produces a merged summary.
 *
 * Also updates the `updated_at` timestamp.
 *
 * Phase 1E: scoped to the caller's tenant. A user cannot UPDATE an
 * entity owned by another user. The Cypher MATCH includes the tenant
 * filter — attempts to update another user's entity silently no-op
 * (zero rows matched). Structural enforcement of cross-user
 * INVALIDATE / UPDATE = downgrade-only.
 */
export async function updateEntitySummary(
  entityId: string,
  newSummary: string,
  filter: TenantFilter,
): Promise<void> {
  const g = getGraph();
  if (!filter || !filter.callerUserId) {
    throw new Error(
      "updateEntitySummary: TenantFilter with callerUserId is required (Phase 1E).",
    );
  }
  const { fragment, params: tenantParams } = applyTenantFilter("e", filter);
  await g.query(
    `MATCH (e:Entity {id: $id})
     WHERE ${fragment}
     SET e.summary = $summary, e.updated_at = $now`,
    {
      params: {
        id: entityId,
        summary: newSummary,
        now: Date.now(),
        ...tenantParams,
      },
    },
  );
}

/**
 * Soft-invalidate an entity's summary (Mem0 DELETE/INVALIDATE pattern).
 * Prepends "[INVALIDATED]" to the summary rather than deleting the node.
 * The entity and its edges are preserved for historical graph traversal.
 *
 * Phase 1E (downgrade-only): a user can INVALIDATE THEIR OWN entity
 * summary; they cannot reach into another user's graph to mark THEIR
 * view of the same person/concept as invalid. The MATCH includes the
 * tenant filter — cross-user INVALIDATE attempts silently no-op
 * (zero rows matched). This is the audit synthesis's "Cross-user
 * INVALIDATE = downgrade-only" enforced at the graph layer.
 */
export async function invalidateEntitySummary(
  entityId: string,
  filter: TenantFilter,
): Promise<void> {
  const g = getGraph();
  if (!filter || !filter.callerUserId) {
    throw new Error(
      "invalidateEntitySummary: TenantFilter with callerUserId is required (Phase 1E).",
    );
  }
  const { fragment, params: tenantParams } = applyTenantFilter("e", filter);
  await g.query(
    `MATCH (e:Entity {id: $id})
     WHERE ${fragment}
     SET e.summary = '[INVALIDATED] ' + e.summary, e.updated_at = $now`,
    {
      params: {
        id: entityId,
        now: Date.now(),
        ...tenantParams,
      },
    },
  );
}

/**
 * Create a fact-bearing edge between two nodes.
 * Ported from Graphiti — edges store natural-language facts,
 * temporal validity windows, and provenance episode lists.
 *
 * Now also stores belief_state and source_authority for Phase 4
 * authority-weighted contradiction resolution.
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
  validAt: number | null | undefined,
  invalidAt: number | null | undefined,
  sourceAuthority: number,
  beliefState: BeliefState,
  tenant: TenantStamp,
): Promise<void> {
  if (!tenant || !tenant.userId) {
    throw new Error(
      "createFactEdge: TenantStamp with userId is required (Phase 1E). " +
      "Untagged fact edges create cross-tenant leak risk.",
    );
  }
  const g = getGraph();
  const now = Date.now();

  // Check for existing edge of same type between same nodes AND same tenant.
  // Fact edges are tenant-isolated: two users may both assert "Kyle works_at
  // HOPE Center" → they appear as two fact edges, one per tenant, with their
  // own authority/belief_state. Dedup applies within a tenant only.
  const existing = await g.query(
    `MATCH (a:${fromLabel} {id: $fromId})-[r:${edgeType}]->(b:${toLabel} {id: $toId})
     WHERE r.tenant_user_id = $tenantUserId
     RETURN r.source_episode_id AS epId, r.fact AS fact
     LIMIT 1`,
    { params: { fromId, toId, tenantUserId: tenant.userId } },
  );

  if (existing.data && existing.data.length > 0) {
    // Edge exists — update fact, provenance, and authority metadata
    await g.query(
      `MATCH (a:${fromLabel} {id: $fromId})-[r:${edgeType}]->(b:${toLabel} {id: $toId})
       WHERE r.tenant_user_id = $tenantUserId
       SET r.fact = $fact,
           r.episode_ids = coalesce(r.episode_ids, []) + [$episodeId],
           r.valid_until = $invalidAt,
           r.source_authority = $sourceAuthority,
           r.belief_state = $beliefState`,
      {
        params: {
          fromId,
          toId,
          fact,
          episodeId,
          invalidAt: invalidAt ?? null,
          sourceAuthority,
          beliefState,
          tenantUserId: tenant.userId,
        },
      },
    );
  } else {
    // New edge — include belief_state, source_authority, and tenant from the start
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
         episode_ids: [$episodeId],
         belief_state: $beliefState,
         source_authority: $sourceAuthority,
         tenant_user_id: $tenantUserId,
         tenant_org_id: $tenantOrgId
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
          beliefState,
          sourceAuthority,
          tenantUserId: tenant.userId,
          tenantOrgId: tenant.organizationId ?? null,
        },
      },
    );
  }
}

/**
 * Update the belief_state of all fact edges created by a specific episode.
 * Used by contradiction detection to mark facts as confirmed/weakened/questioned.
 */
export async function updateFactEdgeBeliefState(
  fromLabel: string,
  fromId: string,
  toLabel: string,
  toId: string,
  edgeType: EdgeType,
  episodeId: string,
  newBeliefState: BeliefState,
  filter: TenantFilter,
): Promise<void> {
  const g = getGraph();
  if (!filter || !filter.callerUserId) {
    throw new Error(
      "updateFactEdgeBeliefState: TenantFilter with callerUserId is required (Phase 1E).",
    );
  }
  await g.query(
    `MATCH (a:${fromLabel} {id: $fromId})-[r:${edgeType}]->(b:${toLabel} {id: $toId})
     WHERE r.source_episode_id = $episodeId
       AND r.tenant_user_id = $callerUserId
     SET r.belief_state = $beliefState`,
    {
      params: {
        fromId,
        toId,
        episodeId,
        beliefState: newBeliefState,
        callerUserId: filter.callerUserId,
      },
    },
  );
}
