import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { initGraph, closeGraph } from "../graph.js";
import { retain } from "../verbs/retain.js";
import { recall } from "../verbs/recall.js";
import type { TenantStamp, TenantFilter } from "../types.js";

const TEST_DATA_PATH = `/tmp/mimir-recall-test-${Date.now()}`;
const TEST_TENANT: TenantStamp = { userId: "test_user_recall" };
const TEST_FILTER: TenantFilter = { callerUserId: "test_user_recall" };

describe("recall verb", () => {
  beforeAll(async () => {
    await initGraph(TEST_DATA_PATH);
    // Seed test data (tenant-stamped)
    await retain("Trust is foundational to the school project", "chat", [], undefined, TEST_TENANT);
    await retain("The routing dashboard needs multi-user support", "chat", [], undefined, TEST_TENANT);
    await retain("Catherine founded Lighthouse Holyoke school", "chat", [], undefined, TEST_TENANT);
  });

  afterAll(async () => {
    await closeGraph();
  });

  test("returns results for a query", async () => {
    const result = await recall("school", TEST_FILTER);
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.query).toBe("school");
    expect(result.strategies_used.length).toBeGreaterThan(0);
  });

  test("returns RecallResponse structure", async () => {
    const result = await recall("trust", TEST_FILTER);
    expect(result).toHaveProperty("results");
    expect(result).toHaveProperty("query");
    expect(result).toHaveProperty("strategies_used");
    expect(Array.isArray(result.results)).toBe(true);
    if (result.results.length > 0) {
      const first = result.results[0];
      expect(first).toHaveProperty("id");
      expect(first).toHaveProperty("content");
      expect(first).toHaveProperty("type");
      expect(first).toHaveProperty("score");
    }
  });

  test("results are sorted by score descending", async () => {
    const result = await recall("project", TEST_FILTER);
    for (let i = 1; i < result.results.length; i++) {
      expect(result.results[i].score).toBeLessThanOrEqual(result.results[i - 1].score);
    }
  });

  test("temporal filtering narrows results", async () => {
    const future = Date.now() + 86400000; // tomorrow
    const result = await recall("trust", TEST_FILTER, undefined, { from: future });
    expect(result).toHaveProperty("results");
    expect(result).toHaveProperty("query");
  });
});
