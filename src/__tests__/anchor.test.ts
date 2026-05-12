import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { initGraph, closeGraph, createNode, getGraph } from "../graph.js";
import { anchor } from "../verbs/anchor.js";
import type { TenantStamp } from "../types.js";

const TEST_DATA_PATH = `/tmp/mimir-anchor-test-${Date.now()}`;
const TEST_TENANT: TenantStamp = { userId: "test_user_anchor" };

describe("anchor verb", () => {
  beforeAll(async () => {
    await initGraph(TEST_DATA_PATH);

    await createNode("Entity", {
      name: "Education",
      type: "domain",
      summary: "Educational practices and philosophy",
      synonyms: ["education"],
      created_at: Date.now(),
      updated_at: Date.now(),
    }, TEST_TENANT);
  });

  afterAll(async () => {
    await closeGraph();
  });

  test("creates an anchor node", async () => {
    const result = await anchor(
      "Every child deserves to be seen and heard",
      "education",
      TEST_TENANT,
    );
    expect(result.created).toBe(true);
    expect(result.anchor_id).toBeDefined();
    expect(result.content).toBe("Every child deserves to be seen and heard");
    expect(result.domain).toBe("education");
    expect(result.superseded).toEqual([]);
  });

  test("anchor exists in graph", async () => {
    const g = getGraph();
    const result = await g.query(
      `MATCH (a:Anchor {domain: 'education'})
       RETURN a.content AS content, a.weight AS weight`,
    );
    expect(result.data).toBeTruthy();
    expect(result.data!.length).toBeGreaterThan(0);
  });

  test("creates constrains edge to domain entity", async () => {
    const result = await anchor(
      "Learning happens through relationship, not curriculum alone",
      "education",
      TEST_TENANT,
    );
    expect(result.constrained_entities.length).toBeGreaterThan(0);
    expect(result.constrained_entities).toContain("Education");
  });

  test("supersedes existing anchor in same domain", async () => {
    const result = await anchor(
      "Trust is the prerequisite for learning",
      "education",
      TEST_TENANT,
    );
    expect(result.created).toBe(true);
    expect(result.superseded.length).toBeGreaterThan(0);
    expect(result.superseded[0]).toHaveProperty("id");
    expect(result.superseded[0]).toHaveProperty("content");
  });

  test("superseded anchors have reduced weight", async () => {
    const g = getGraph();
    const result = await g.query(
      `MATCH (a:Anchor {domain: 'education'})
       WHERE a.weight = 0.1
       RETURN count(a) AS cnt`,
    );
    const cnt = (result.data![0] as Record<string, unknown>).cnt as number;
    expect(cnt).toBeGreaterThan(0);
  });

  test("accepts custom weight", async () => {
    const result = await anchor("Health enables everything", "health", TEST_TENANT, 0.8);
    expect(result.created).toBe(true);

    const g = getGraph();
    const check = await g.query(
      `MATCH (a:Anchor {id: $id}) RETURN a.weight AS weight`,
      { params: { id: result.anchor_id } },
    );
    expect((check.data![0] as Record<string, unknown>).weight).toBe(0.8);
  });
});
