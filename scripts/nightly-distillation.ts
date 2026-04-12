#!/usr/bin/env bun
/**
 * Mimir — Nightly Distillation
 *
 * Runs the reflect verb over the past 24 hours, then stores the
 * synthesis as a new Thought in the graph. Designed to run via launchd
 * on a daily schedule.
 *
 * Usage: bun run scripts/nightly-distillation.ts
 */

import { initGraph, closeGraph, createNode, createEdge } from "../src/graph.js";
import { reflect } from "../src/verbs/reflect.js";
import { generateEmbedding } from "../src/embeddings.js";

const DATA_PATH =
  process.env.MIMIR_DATA_PATH || "/Volumes/AI-Lab/falkordb-data/personal-brain";

async function main() {
  console.log(`[distillation] Starting nightly distillation at ${new Date().toISOString()}`);

  await initGraph(DATA_PATH);

  const now = Date.now();
  const oneDayAgo = now - 24 * 60 * 60 * 1000;

  // Run reflect over the past 24 hours
  const result = await reflect(undefined, { from: oneDayAgo, to: now });

  console.log(`[distillation] Analyzed ${result.thoughts_analyzed} thoughts`);
  console.log(`[distillation] Patterns: ${result.patterns.length}`);
  console.log(`[distillation] Gaps: ${result.gaps.length}`);
  console.log(`[distillation] Evolving ideas: ${result.evolving_ideas.length}`);

  if (result.thoughts_analyzed === 0) {
    console.log("[distillation] No activity in the past 24 hours. Skipping synthesis.");
    await closeGraph();
    return;
  }

  // Store the synthesis as a distillation Thought
  const synthesisContent = [
    `Daily distillation (${new Date(oneDayAgo).toLocaleDateString()} → ${new Date(now).toLocaleDateString()}):`,
    "",
    result.synthesis,
    "",
    result.patterns.length > 0
      ? `Themes: ${result.patterns.map((p) => `${p.theme} (×${p.frequency})`).join(", ")}`
      : "",
    result.gaps.length > 0
      ? `Gaps: ${result.gaps.map((g) => g.domain).join(", ")}`
      : "",
    result.evolving_ideas.length > 0
      ? `Evolving: ${result.evolving_ideas.map((e) => e.summary).join("; ")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  // Generate embedding for the synthesis
  const embedding = await generateEmbedding(synthesisContent);

  // Store as a distillation Thought
  const thoughtId = await createNode("Thought", {
    content: synthesisContent,
    embedding,
    source: "distillation",
    confidence: 0.9,
    created_at: now,
  });

  // Create Episode for provenance
  const episodeId = await createNode("Episode", {
    content: synthesisContent,
    source_type: "document",
    participants: [],
    timestamp: now,
    processed: true,
  });

  await createEdge("Thought", thoughtId, "Episode", episodeId, "extracted_from", {
    source_episode_id: episodeId,
  });

  console.log(`[distillation] Stored synthesis as Thought ${thoughtId}`);
  console.log(`[distillation] Content: ${synthesisContent.slice(0, 200)}...`);

  await closeGraph();
  console.log("[distillation] Done.");
}

main().catch((err) => {
  console.error("[distillation] Fatal error:", err);
  process.exit(1);
});
