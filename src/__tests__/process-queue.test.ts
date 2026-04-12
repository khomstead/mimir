import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { initGraph, closeGraph, createNode, createEdge, getGraph } from "../graph.js";
import { processQueue } from "../verbs/process-queue.js";

const TEST_DATA_PATH = `/tmp/mimir-queue-test-${Date.now()}`;

describe("processQueue", () => {
  beforeAll(async () => {
    await initGraph(TEST_DATA_PATH);

    // Seed: unprocessed episode + linked thought
    const epId = await createNode("Episode", {
      content: "Kyle discussed the school project with Catherine",
      source_type: "conversation",
      participants: ["Kyle", "Catherine"],
      timestamp: Date.now(),
      processed: false,
    });

    const tId = await createNode("Thought", {
      content: "Kyle discussed the school project with Catherine",
      embedding: new Array(1536).fill(0),
      source: "chat",
      confidence: 0,
      created_at: Date.now(),
    });

    await createEdge("Thought", tId, "Episode", epId, "extracted_from");

    // Also seed a processed episode (should be skipped)
    await createNode("Episode", {
      content: "Already processed content",
      source_type: "conversation",
      participants: [],
      timestamp: Date.now(),
      processed: true,
    });
  });

  afterAll(async () => {
    await closeGraph();
  });

  test("finds unprocessed episodes", async () => {
    const g = getGraph();
    const result = await g.query(
      `MATCH (ep:Episode) WHERE ep.processed = false RETURN count(ep) AS cnt`,
    );
    expect((result.data![0] as Record<string, unknown>).cnt).toBe(1);
  });

  test("skips when no API key available", async () => {
    // Force deferred mode — BRAIN_DISABLE_LLM bypasses .env fallback reader
    const originalKey = process.env.ANTHROPIC_API_KEY;
    const originalDisable = process.env.BRAIN_DISABLE_LLM;
    delete process.env.ANTHROPIC_API_KEY;
    process.env.BRAIN_DISABLE_LLM = "true";

    const result = await processQueue();
    expect(result.skipped).toBe(1);
    expect(result.processed).toBe(0);
    expect(result.failed).toBe(0);

    if (originalKey) process.env.ANTHROPIC_API_KEY = originalKey;
    if (originalDisable) process.env.BRAIN_DISABLE_LLM = originalDisable;
    else delete process.env.BRAIN_DISABLE_LLM;
  });

  test("returns valid QueueProcessResult structure", async () => {
    const result = await processQueue();
    expect(result).toHaveProperty("processed");
    expect(result).toHaveProperty("failed");
    expect(result).toHaveProperty("skipped");
    expect(result).toHaveProperty("details");
    expect(Array.isArray(result.details)).toBe(true);
  });
});
