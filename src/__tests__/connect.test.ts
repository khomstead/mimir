import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { initGraph, closeGraph, createNode, getGraph } from "../graph.js";
import { connect } from "../verbs/connect.js";
import type { TenantStamp, TenantFilter } from "../types.js";

const TEST_DATA_PATH = `/tmp/mimir-connect-test-${Date.now()}`;
const TEST_TENANT: TenantStamp = { userId: "test_user_connect" };
const TEST_FILTER: TenantFilter = { callerUserId: "test_user_connect" };

describe("connect verb", () => {
  let entity1Id: string;
  let entity2Id: string;

  beforeAll(async () => {
    await initGraph(TEST_DATA_PATH);

    entity1Id = await createNode("Entity", {
      name: "Kyle",
      type: "person",
      summary: "Primary user",
      synonyms: ["kyle_homstead"],
      created_at: Date.now(),
      updated_at: Date.now(),
    }, TEST_TENANT);

    entity2Id = await createNode("Entity", {
      name: "School Project",
      type: "project",
      summary: "Innovative school",
      synonyms: ["school_project"],
      created_at: Date.now(),
      updated_at: Date.now(),
    }, TEST_TENANT);
  });

  afterAll(async () => {
    await closeGraph();
  });

  test("connects two entities by name", async () => {
    const result = await connect("Kyle", "School Project", TEST_FILTER, "Kyle leads the school project");
    expect(result.connected).toBe(true);
    expect(result.source_id).toBe(entity1Id);
    expect(result.target_id).toBe(entity2Id);
    expect(result.edge_type).toBe("relates_to");
    expect(result.rationale).toContain("Kyle leads");
  });

  test("creates edge with specified type", async () => {
    const result = await connect("Kyle", "School Project", TEST_FILTER, "Kyle contributes to it", "contributes_to");
    expect(result.edge_type).toBe("contributes_to");
  });

  test("edge exists in graph after connect", async () => {
    const g = getGraph();
    const edgeResult = await g.query(
      `MATCH (a:Entity {id: $from})-[r:relates_to]->(b:Entity {id: $to})
       RETURN r.type AS type`,
      { params: { from: entity1Id, to: entity2Id } },
    );
    expect(edgeResult.data).toBeTruthy();
    expect(edgeResult.data!.length).toBeGreaterThan(0);
  });

  test("connects by node ID", async () => {
    const result = await connect(entity1Id, entity2Id, TEST_FILTER, "ID-based connection");
    expect(result.connected).toBe(true);
  });

  test("throws for unknown source", async () => {
    expect(
      connect("NonexistentEntity123", "Kyle", TEST_FILTER, "test"),
    ).rejects.toThrow(/Source not found/);
  });

  test("throws for unknown target", async () => {
    expect(
      connect("Kyle", "NonexistentEntity456", TEST_FILTER, "test"),
    ).rejects.toThrow(/Target not found/);
  });
});
