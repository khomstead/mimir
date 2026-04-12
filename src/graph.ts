/**
 * Mimir — FalkorDBLite Graph Layer
 *
 * Manages the persistent graph database connection, schema creation,
 * and core graph operations (node/edge CRUD, vector search).
 */

import { FalkorDB } from "falkordblite";
import type { Graph } from "falkordb";
import type { EdgeType } from "./types.js";

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
    .query(
      "CREATE VECTOR INDEX FOR (t:Thought) ON (t.embedding) OPTIONS {dimension: 1536, similarityFunction: 'cosine'}"
    )
    .catch(() => {});

  return graph;
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
 * Returns the generated UUID.
 */
export async function createNode(
  label: string,
  props: Record<string, unknown>
): Promise<string> {
  const g = getGraph();
  const id = uuid();
  const allProps = { id, ...props };

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
 * Find an entity by name (case-insensitive).
 * Searches both the `name` property and the `synonyms` array.
 */
export async function findEntityByName(
  name: string
): Promise<{ id: string; name: string; type: string; summary: string } | null> {
  const g = getGraph();

  // Search by name OR check if any synonym matches (case-insensitive)
  const result = await g.query(
    `MATCH (e:Entity)
     WHERE toLower(e.name) = toLower($name)
        OR any(s IN e.synonyms WHERE toLower(s) = toLower($name))
     RETURN e.id AS id, e.name AS name, e.type AS type, e.summary AS summary
     LIMIT 1`,
    { params: { name } }
  );

  if (result.data && result.data.length > 0) {
    const row = result.data[0] as Record<string, unknown>;
    return {
      id: row.id as string,
      name: row.name as string,
      type: row.type as string,
      summary: row.summary as string,
    };
  }

  return null;
}

/**
 * Vector similarity search over Thought nodes.
 * Returns the top-k most similar thoughts by embedding cosine distance.
 */
export async function vectorSearch(
  queryEmbedding: number[],
  k: number = 10
): Promise<Array<{ id: string; content: string; score: number; created_at: number }>> {
  const g = getGraph();

  const result = await g.query(
    `CALL db.idx.vector.queryNodes('Thought', 'embedding', $k, vecf32($embedding))
     YIELD node, score
     RETURN node.id AS id, node.content AS content, score, node.created_at AS created_at
     ORDER BY score ASC`,
    { params: { k, embedding: queryEmbedding } }
  );

  if (!result.data || result.data.length === 0) {
    return [];
  }

  return (result.data as Record<string, unknown>[]).map((row) => ({
    id: row.id as string,
    content: row.content as string,
    score: row.score as number,
    created_at: row.created_at as number,
  }));
}
