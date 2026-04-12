/**
 * Mimir — Retain Verb Tests
 *
 * Runs without API keys (extraction and embedding both fall back gracefully).
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { initGraph, closeGraph, getGraph } from "../graph.js";
import { retain } from "../verbs/retain.js";

const TEST_DATA_PATH = `/tmp/mimir-retain-test-${Date.now()}`;

describe("retain verb", () => {
  beforeAll(async () => {
    await initGraph(TEST_DATA_PATH);
  });

  afterAll(async () => {
    await closeGraph();
  });

  test("creates Episode and Thought from raw text", async () => {
    const result = await retain(
      "Trust is the foundation of the school project",
      "chat",
    );
    expect(result.stored).toBe(true);
    expect(result.thought_id).toBeDefined();
    expect(result.episode_id).toBeDefined();
    expect(typeof result.thought_id).toBe("string");
    expect(typeof result.episode_id).toBe("string");
  });

  test("Episode is linked to Thought via extracted_from", async () => {
    const g = getGraph();
    const result = await g.query(
      `MATCH (t:Thought)-[:extracted_from]->(ep:Episode) RETURN count(*) AS cnt`,
    );
    expect(
      (result.data as Record<string, unknown>[])[0].cnt,
    ).toBeGreaterThanOrEqual(1);
  });

  test("returns valid RetainResponse structure", async () => {
    const result = await retain(
      "Kyle met with Catherine about curriculum",
    );
    expect(result).toHaveProperty("stored");
    expect(result).toHaveProperty("thought_id");
    expect(result).toHaveProperty("episode_id");
    expect(result).toHaveProperty("entities_extracted");
    expect(result).toHaveProperty("connections");
    expect(result).toHaveProperty("tensions");
    expect(result).toHaveProperty("extracted");
    expect(result.extracted).toHaveProperty("action_required");
    expect(Array.isArray(result.entities_extracted)).toBe(true);
    expect(Array.isArray(result.tensions)).toBe(true);
  });
});
