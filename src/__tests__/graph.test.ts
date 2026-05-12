/**
 * Mimir — Graph Layer Tests
 *
 * Phase 1E: createNode / findEntityByName / vectorSearch all require a
 * TenantStamp or TenantFilter. These tests use a single TEST_TENANT
 * across all assertions; cross-tenant isolation is asserted in
 * `tenant-isolation.test.ts`.
 */

import { describe, it, expect, afterAll } from "bun:test";
import {
  initGraph,
  closeGraph,
  getGraph,
  createNode,
  createEdge,
  findEntityByName,
  vectorSearch,
} from "../graph.js";
import type { TenantStamp, TenantFilter } from "../types.js";

const TEST_DATA_PATH = `/tmp/mimir-test-${Date.now()}`;
const TEST_TENANT: TenantStamp = { userId: "test_user_graph" };
const TEST_FILTER: TenantFilter = { callerUserId: "test_user_graph" };

describe("graph", () => {
  afterAll(async () => {
    await closeGraph();
  });

  it("initializes graph and creates schema", async () => {
    const g = await initGraph(TEST_DATA_PATH);
    expect(g).toBeTruthy();
    expect(getGraph()).toBe(g);
  });

  it("creates an Entity node", async () => {
    const id = await createNode("Entity", {
      name: "Kyle",
      type: "person",
      summary: "Primary user and co-developer",
      synonyms: ["Kyle Homstead", "KH"],
      created_at: Date.now(),
      updated_at: Date.now(),
    }, TEST_TENANT);
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });

  it("finds entity by name (case insensitive)", async () => {
    const result = await findEntityByName("kyle", TEST_FILTER);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("Kyle");
    expect(result!.type).toBe("person");

    const bySynonym = await findEntityByName("KH", TEST_FILTER);
    expect(bySynonym).not.toBeNull();
    expect(bySynonym!.name).toBe("Kyle");
  });

  it("creates a Thought node", async () => {
    const embedding = Array.from({ length: 1536 }, () => Math.random());
    const id = await createNode("Thought", {
      content: "The brain MCP server should use FalkorDBLite for persistence",
      embedding,
      source: "chat",
      confidence: 0.9,
      created_at: Date.now(),
    }, TEST_TENANT);
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });

  it("creates an edge between Entity and Thought", async () => {
    const g = getGraph();
    const entityResult = await g.query(
      "MATCH (e:Entity {name: 'Kyle'}) RETURN e.id AS id LIMIT 1"
    );
    const entityId = (entityResult.data![0] as Record<string, unknown>).id as string;
    const thoughtResult = await g.query(
      "MATCH (t:Thought) RETURN t.id AS id LIMIT 1"
    );
    const thoughtId = (thoughtResult.data![0] as Record<string, unknown>).id as string;
    await createEdge("Entity", entityId, "Thought", thoughtId, "authored_by");
    const edgeResult = await g.query(
      `MATCH (e:Entity {id: $entityId})-[r:authored_by]->(t:Thought {id: $thoughtId})
       RETURN r.type AS type, r.confidence AS confidence`,
      { params: { entityId, thoughtId } }
    );
    expect(edgeResult.data).toBeTruthy();
    expect(edgeResult.data!.length).toBe(1);
    const row = edgeResult.data![0] as Record<string, unknown>;
    expect(row.type).toBe("authored_by");
    expect(row.confidence).toBe(1.0);
  });

  it("vectorSearch returns similar thoughts ranked by score", async () => {
    const closeEmbedding = Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1.0 : 0.0));
    const farEmbedding = Array.from({ length: 1536 }, (_, i) => (i === 500 ? 1.0 : 0.0));

    await createNode("Thought", {
      content: "Close thought about trust",
      embedding: closeEmbedding,
      source: "chat",
      confidence: 0.9,
      created_at: Date.now(),
    }, TEST_TENANT);
    await createNode("Thought", {
      content: "Far thought about routing",
      embedding: farEmbedding,
      source: "chat",
      confidence: 0.9,
      created_at: Date.now(),
    }, TEST_TENANT);

    const queryVec = Array.from({ length: 1536 }, (_, i) => (i === 0 ? 0.9 : 0.05));
    const results = await vectorSearch(queryVec, 5, TEST_FILTER);

    expect(results.length).toBeGreaterThanOrEqual(2);
    const closeResult = results.find((r) => r.content.includes("Close thought"));
    const farResult = results.find((r) => r.content.includes("Far thought"));
    expect(closeResult).toBeDefined();
    expect(farResult).toBeDefined();
    expect(closeResult!.score).toBeLessThan(farResult!.score);
  });

  it("creates an Anchor node", async () => {
    const id = await createNode("Anchor", {
      content: "Nothing falls through the cracks",
      domain: "operating_principles",
      weight: 1.0,
      created_at: Date.now(),
    }, TEST_TENANT);
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);

    const g = getGraph();
    const result = await g.query(
      "MATCH (a:Anchor {id: $id}) RETURN a.content AS content, a.domain AS domain",
      { params: { id } }
    );
    expect(result.data).toBeTruthy();
    expect(result.data!.length).toBe(1);
    const row = result.data![0] as Record<string, unknown>;
    expect(row.content).toBe("Nothing falls through the cracks");
    expect(row.domain).toBe("operating_principles");
  });
});
