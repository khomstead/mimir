import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { initGraph, closeGraph, createNode, createEdge } from "../graph.js";
import { pulse } from "../verbs/pulse.js";
import type { TenantStamp, TenantFilter } from "../types.js";

const TEST_DATA_PATH = `/tmp/mimir-pulse-test-${Date.now()}`;
const TEST_TENANT: TenantStamp = { userId: "test_user_pulse" };
const TEST_FILTER: TenantFilter = { callerUserId: "test_user_pulse" };

describe("pulse verb", () => {
  let entityId: string;

  beforeAll(async () => {
    await initGraph(TEST_DATA_PATH);

    entityId = await createNode("Entity", {
      name: "School Project",
      type: "project",
      summary: "An innovative school initiative",
      synonyms: ["school_project"],
      created_at: Date.now(),
      updated_at: Date.now(),
    }, TEST_TENANT);

    const thoughtId = await createNode("Thought", {
      content: "Trust is foundational to the school project",
      embedding: new Array(1024).fill(0),
      source: "chat",
      confidence: 0.8,
      created_at: Date.now(),
    }, TEST_TENANT);

    await createEdge("Thought", thoughtId, "Entity", entityId, "contributes_to");

    await createNode("Anchor", {
      content: "Every child deserves to be seen",
      domain: "school",
      weight: 1.0,
      created_at: Date.now(),
    }, TEST_TENANT);
  });

  afterAll(async () => {
    await closeGraph();
  });

  test("returns PulseResponse for a known entity", async () => {
    const result = await pulse("School Project", TEST_FILTER);
    expect(result.entity_or_domain).toBe("School Project");
    expect(result.summary).toBeDefined();
    expect(result.summary.length).toBeGreaterThan(0);
    expect(result.recent_thoughts.length).toBeGreaterThan(0);
    expect(result.activity_period).toHaveProperty("thought_count");
  });

  test("returns PulseResponse for a domain string", async () => {
    const result = await pulse("school", TEST_FILTER);
    expect(result.entity_or_domain).toBeDefined();
    expect(result).toHaveProperty("active_anchors");
    expect(result).toHaveProperty("recent_thoughts");
    expect(result).toHaveProperty("connections");
    expect(result).toHaveProperty("unresolved_tensions");
  });

  test("returns valid structure even for unknown entity", async () => {
    const result = await pulse("nonexistent_entity_xyz", TEST_FILTER);
    expect(result.entity_or_domain).toBe("nonexistent_entity_xyz");
    expect(result.recent_thoughts).toEqual([]);
    expect(result.activity_period.thought_count).toBe(0);
  });

  test("finds active anchors in domain", async () => {
    const result = await pulse("school", TEST_FILTER);
    expect(result.active_anchors.length).toBeGreaterThan(0);
    expect(result.active_anchors[0].content).toContain("child");
  });
});
