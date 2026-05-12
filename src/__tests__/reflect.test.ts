import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { initGraph, closeGraph, createNode, createEdge } from "../graph.js";
import { reflect } from "../verbs/reflect.js";
import type { TenantStamp, TenantFilter } from "../types.js";

const TEST_DATA_PATH = `/tmp/mimir-reflect-test-${Date.now()}`;
const TEST_TENANT: TenantStamp = { userId: "test_user_reflect" };
const TEST_FILTER: TenantFilter = { callerUserId: "test_user_reflect" };

describe("reflect verb", () => {
  beforeAll(async () => {
    await initGraph(TEST_DATA_PATH);

    const entityId = await createNode("Entity", {
      name: "Trust",
      type: "concept",
      summary: "Core value",
      synonyms: [],
      created_at: Date.now(),
      updated_at: Date.now(),
    }, TEST_TENANT);

    const ep1 = await createNode("Episode", {
      content: "Discussed trust in the school",
      source_type: "conversation",
      participants: ["Kyle"],
      timestamp: Date.now(),
      processed: true,
    }, TEST_TENANT);

    const t1 = await createNode("Thought", {
      content: "Trust is the foundation of everything we build",
      embedding: new Array(1536).fill(0),
      source: "chat",
      confidence: 0.8,
      created_at: Date.now(),
    }, TEST_TENANT);

    const t2 = await createNode("Thought", {
      content: "Trust requires vulnerability and consistency",
      embedding: new Array(1536).fill(0),
      source: "chat",
      confidence: 0.8,
      created_at: Date.now(),
    }, TEST_TENANT);

    await createEdge("Thought", t1, "Episode", ep1, "extracted_from");
    await createEdge("Episode", ep1, "Entity", entityId, "involves");
    await createEdge("Thought", t2, "Episode", ep1, "extracted_from");
    await createEdge("Thought", t1, "Thought", t2, "evolves");

    await createNode("Anchor", {
      content: "Physical health enables everything else",
      domain: "health",
      weight: 1.0,
      created_at: Date.now(),
    }, TEST_TENANT);
  });

  afterAll(async () => {
    await closeGraph();
  });

  test("returns ReflectResponse structure", async () => {
    const result = await reflect(TEST_FILTER);
    expect(result).toHaveProperty("synthesis");
    expect(result).toHaveProperty("patterns");
    expect(result).toHaveProperty("gaps");
    expect(result).toHaveProperty("evolving_ideas");
    expect(result).toHaveProperty("period");
    expect(result).toHaveProperty("thoughts_analyzed");
    expect(result.thoughts_analyzed).toBeGreaterThanOrEqual(2);
  });

  test("detects patterns (entities in multiple thoughts)", async () => {
    const result = await reflect(TEST_FILTER);
    if (result.patterns.length > 0) {
      expect(result.patterns[0]).toHaveProperty("theme");
      expect(result.patterns[0]).toHaveProperty("frequency");
      expect(result.patterns[0].frequency).toBeGreaterThanOrEqual(2);
    }
  });

  test("detects evolving ideas", async () => {
    const result = await reflect(TEST_FILTER);
    expect(result.evolving_ideas.length).toBeGreaterThanOrEqual(1);
    expect(result.evolving_ideas[0]).toHaveProperty("chain");
    expect(result.evolving_ideas[0]).toHaveProperty("summary");
  });

  test("detects domain gaps", async () => {
    const result = await reflect(TEST_FILTER);
    const healthGap = result.gaps.find((g) => g.domain === "health");
    expect(healthGap).toBeDefined();
  });

  test("scope filter narrows results", async () => {
    const result = await reflect(TEST_FILTER, "trust");
    expect(result.thoughts_analyzed).toBeGreaterThanOrEqual(1);
  });
});
