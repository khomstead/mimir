/**
 * Mimir — Connect Verb
 *
 * Explicit inference. Creates relationship edges between entities or thoughts
 * that the human has identified. The Intelligence Layer also creates connections
 * automatically during extraction, but this verb lets a human say:
 * "I see a connection the system hasn't noticed."
 */

import { getGraph, createEdge, findEntityByName } from "../graph.js";
import { validateEdgeType } from "../extraction.js";
import type { ConnectResponse, EdgeType, TenantFilter } from "../types.js";

/**
 * Find a node (Entity or Thought) by name or ID, scoped to caller's tenant.
 * Returns { id, label } or null.
 *
 * Phase 1E: ID-based fallback also filters by tenant_user_id, so the
 * caller can only resolve their own nodes by ID. A node ID owned by
 * another user is silently treated as "not found."
 */
async function findNode(
  nameOrId: string,
  filter: TenantFilter,
): Promise<{ id: string; label: string } | null> {
  // Try as entity name first (tenant-scoped)
  const entity = await findEntityByName(nameOrId, filter);
  if (entity) return { id: entity.id, label: "Entity" };

  // Try as a node ID (could be Entity, Thought, or Anchor) — tenant-scoped.
  const g = getGraph();
  for (const label of ["Entity", "Thought", "Anchor"]) {
    const result = await g.query(
      `MATCH (n:${label} {id: $id})
       WHERE n.tenant_user_id = $callerUserId
       RETURN n.id AS id LIMIT 1`,
      { params: { id: nameOrId, callerUserId: filter.callerUserId } },
    );
    if (result.data && result.data.length > 0) {
      return { id: nameOrId, label };
    }
  }

  return null;
}

/**
 * Create an explicit connection between two nodes.
 *
 * Phase 1E: both endpoint nodes must belong to the caller's tenant.
 * Cross-tenant `connect()` is rejected at the resolver — if either
 * node isn't visible to the caller, the operation throws "not found".
 *
 * @param source - Name or ID of the source node
 * @param target - Name or ID of the target node
 * @param filter - TenantFilter identifying the caller
 * @param rationale - Why this connection exists
 * @param edgeType - Relationship type (defaults to "relates_to")
 */
export async function connect(
  source: string,
  target: string,
  filter: TenantFilter,
  rationale?: string,
  edgeType?: string,
): Promise<ConnectResponse> {
  if (!filter || !filter.callerUserId) {
    throw new Error(
      "connect: TenantFilter with callerUserId is required (Phase 1E).",
    );
  }
  const sourceNode = await findNode(source, filter);
  if (!sourceNode) {
    throw new Error(`Source not found: "${source}". Provide an entity name or node ID.`);
  }

  const targetNode = await findNode(target, filter);
  if (!targetNode) {
    throw new Error(`Target not found: "${target}". Provide an entity name or node ID.`);
  }

  const validatedType = edgeType ? validateEdgeType(edgeType) : ("relates_to" as EdgeType);

  await createEdge(
    sourceNode.label,
    sourceNode.id,
    targetNode.label,
    targetNode.id,
    validatedType,
    { confidence: 1.0 },
  );

  return {
    connected: true,
    source_id: sourceNode.id,
    target_id: targetNode.id,
    edge_type: validatedType,
    rationale: rationale || `Manual connection: ${source} → ${target}`,
  };
}
