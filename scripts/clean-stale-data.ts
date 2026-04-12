#!/usr/bin/env bun
/**
 * Clean stale test data from production FalkorDB.
 *
 * Finds and removes Thoughts with zero-vector embeddings (artifacts from
 * test runs or captures without OPENAI_API_KEY). Also removes their
 * linked Episodes and edges.
 *
 * Usage: bun run brain-mcp-server/scripts/clean-stale-data.ts [--dry-run]
 */

import { FalkorDB } from "falkordblite";

const DATA_PATH = process.env.BRAIN_DATA_PATH || "/Volumes/AI-Lab/falkordb-data/personal-brain";
const DRY_RUN = process.argv.includes("--dry-run");

async function main() {
  console.log(`[clean] Opening graph at: ${DATA_PATH}`);
  console.log(`[clean] Mode: ${DRY_RUN ? "DRY RUN" : "LIVE — will delete"}`);

  const db = await FalkorDB.open({ path: DATA_PATH });
  const graph = db.selectGraph("mimir");

  // Find all Thoughts — we'll check for zero-vector embeddings
  // FalkorDB doesn't have a great way to check if an embedding is all zeros,
  // so we'll identify thoughts with confidence 0 or very low confidence
  // which indicates they were created via the regex fallback path
  const thoughtsResult = await graph.query(
    `MATCH (t:Thought)
     RETURN t.id AS id, t.content AS content, t.confidence AS confidence,
            t.source AS source, t.created_at AS created_at
     ORDER BY t.created_at ASC`,
  );

  if (!thoughtsResult.data || thoughtsResult.data.length === 0) {
    console.log("[clean] No Thoughts found in graph.");
    await db.close();
    return;
  }

  console.log(`[clean] Found ${thoughtsResult.data.length} total Thoughts`);

  // Identify stale thoughts: confidence <= 0.1 (fallback extraction)
  const staleThoughts: Array<{ id: string; content: string; confidence: number }> = [];
  for (const row of thoughtsResult.data as Record<string, unknown>[]) {
    const confidence = row.confidence as number;
    // Thoughts from regex fallback have confidence 0.1
    // Thoughts from deferred extraction have confidence 0
    if (confidence <= 0.1) {
      staleThoughts.push({
        id: row.id as string,
        content: (row.content as string)?.slice(0, 80),
        confidence,
      });
    }
  }

  if (staleThoughts.length === 0) {
    console.log("[clean] No stale thoughts found (all confidence > 0.1).");
    await db.close();
    return;
  }

  console.log(`\n[clean] Found ${staleThoughts.length} stale thoughts to remove:`);
  for (const t of staleThoughts) {
    console.log(`  - [${t.confidence}] "${t.content}..."`);
  }

  if (DRY_RUN) {
    console.log("\n[clean] DRY RUN — no changes made.");
    await db.close();
    return;
  }

  // Delete stale thoughts and their edges
  let deleted = 0;
  for (const t of staleThoughts) {
    try {
      // Find and delete linked unprocessed Episodes
      await graph.query(
        `MATCH (t:Thought {id: $id})-[:extracted_from]->(ep:Episode)
         WHERE ep.processed = false
         DETACH DELETE ep`,
        { params: { id: t.id } },
      );

      // Delete the Thought and all its edges
      await graph.query(
        `MATCH (t:Thought {id: $id}) DETACH DELETE t`,
        { params: { id: t.id } },
      );
      deleted++;
      console.log(`  ✓ Deleted: "${t.content}..."`);
    } catch (err: any) {
      console.error(`  ✗ Failed to delete ${t.id}: ${err.message}`);
    }
  }

  // Also clean up orphaned entities with no edges
  const orphanResult = await graph.query(
    `MATCH (e:Entity)
     WHERE NOT (e)-[]-()
     RETURN e.id AS id, e.name AS name`,
  );

  let orphansDeleted = 0;
  if (orphanResult.data && orphanResult.data.length > 0) {
    console.log(`\n[clean] Found ${orphanResult.data.length} orphaned entities:`);
    for (const row of orphanResult.data as Record<string, unknown>[]) {
      console.log(`  - ${row.name}`);
      await graph.query(
        `MATCH (e:Entity {id: $id}) DELETE e`,
        { params: { id: row.id as string } },
      );
      orphansDeleted++;
    }
  }

  console.log(`\n[clean] Done. Deleted ${deleted} thoughts, ${orphansDeleted} orphaned entities.`);
  await db.close();
}

main().catch((err) => {
  console.error("[clean] Fatal error:", err);
  process.exit(1);
});
