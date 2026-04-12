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
import type { ConnectResponse, EdgeType } from "../types.js";

/**
 * Find a node (Entity or Thought) by name or ID.
 * Returns { id, label } or null.
 */
async function findNode(
  nameOrId: string,
): Promise<{ id: string; label: string } | null> {
  // Try as entity name first
  const entity = await findEntityByName(nameOrId);
  if (entity) return { id: entity.id, label: "Entity" };

  // Try as a node ID (could be Entity, Thought, or Anchor)
  const g = getGraph();
  for (const label of ["Entity", "Thought", "Anchor"]) {
    const result = await g.query(
      `MATCH (n:${label} {id: $id}) RETURN n.id AS id LIMIT 1`,
      { params: { id: nameOrId } },
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
 * @param source - Name or ID of the source node
 * @param target - Name or ID of the target node
 * @param rationale - Why this connection exists
 * @param edgeType - Relationship type (defaults to "relates_to")
 */
export async function connect(
  source: string,
  target: string,
  rationale?: string,
  edgeType?: string,
): Promise<ConnectResponse> {
  const sourceNode = await findNode(source);
  if (!sourceNode) {
    throw new Error(`Source not found: "${source}". Provide an entity name or node ID.`);
  }

  const targetNode = await findNode(target);
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
