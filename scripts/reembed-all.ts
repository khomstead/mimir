#!/usr/bin/env bun
/**
 * Re-embed every Thought node — vector dimension migration backfill.
 *
 * Why: the graph was populated while embeddings.ts had no embedding backend
 * configured, so every Thought.embedding is an all-zero 1536-vector. After the
 * local-embeddings migration (oMLX, 1024-dim) this script regenerates a REAL
 * 1024-dim embedding for each Thought and migrates the vector index.
 *
 * MUST be run with the mimir service STOPPED — FalkorDBLite is embedded and the
 * service holds an exclusive lock on the data dir. Sequence:
 *   stop com.speki.mimir → run this → restart.
 *
 * Order (safe for a dimension change):
 *   1. read all (id, content)
 *   2. DROP the old-dimension vector index (can't write new-dim vectors under it)
 *   3. re-embed + write back via vecf32()
 *   4. CREATE the index at the new EMBEDDING_DIM (builds from the new vectors)
 *
 * Usage:
 *   bun run scripts/reembed-all.ts            # live
 *   bun run scripts/reembed-all.ts --dry-run  # count only, no writes/index changes
 */

import {
  initGraph,
  getGraph,
  closeGraph,
  dropVectorIndex,
  createVectorIndex,
} from "../src/graph.js";
import { generateEmbedding, EMBEDDING_DIM } from "../src/embeddings.js";

const DATA_PATH =
  process.env.MIMIR_DATA_PATH ||
  process.env.BRAIN_DATA_PATH ||
  "/Volumes/AI-Lab/falkordb-data/personal-brain";
const DRY_RUN = process.argv.includes("--dry-run");
// Serial by default: the local oMLX model server processes one request at a time,
// so sustained concurrency keeps it congested and triggers ECONNRESET storms that
// even per-request retries can't escape (the whole window stays congested).
// Override with MIMIR_REEMBED_CONCURRENCY if the server can take more.
const CONCURRENCY = Math.max(1, Number(process.env.MIMIR_REEMBED_CONCURRENCY ?? "1"));

async function main() {
  console.log(`[reembed] data path: ${DATA_PATH}`);
  console.log(`[reembed] mode: ${DRY_RUN ? "DRY RUN (no writes)" : "LIVE"}`);
  console.log(`[reembed] target dimension: ${EMBEDDING_DIM}`);

  await initGraph(DATA_PATH);
  const g = getGraph();

  // 1. Read every Thought (all tenants — this is a maintenance backfill).
  const res = await g.query(
    "MATCH (t:Thought) RETURN t.id AS id, t.content AS content",
  );
  const rows = ((res.data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    id: r.id as string,
    content: (r.content as string) ?? "",
  }));
  console.log(`[reembed] ${rows.length} Thought nodes found`);

  if (DRY_RUN) {
    const empties = rows.filter((r) => !r.content.trim()).length;
    console.log(`[reembed] ${empties} have empty content (would be skipped)`);
    // Sanity: prove the embedder works end-to-end before a live run.
    if (rows.length > 0) {
      const probe = await generateEmbedding(
        rows.find((r) => r.content.trim())?.content ?? "probe",
      );
      console.log(
        `[reembed] embedder OK — probe vector dim=${probe.length}, ` +
          `first 3=[${probe.slice(0, 3).map((x) => x.toFixed(4)).join(", ")}]`,
      );
    }
    await closeGraph();
    return;
  }

  // 2. Drop the old-dimension vector index BEFORE writing new-dim vectors.
  console.log("[reembed] dropping existing vector index...");
  await dropVectorIndex();

  // 3. Re-embed and write back.
  const embedOne = async (row: { id: string; content: string }) => {
    const embedding = await generateEmbedding(row.content);
    await g.query(
      "MATCH (t:Thought {id: $id}) SET t.embedding = vecf32($embedding)",
      { params: { id: row.id, embedding } },
    );
  };

  let ok = 0;
  let skipped = 0;
  const failures: Array<{ id: string; content: string }> = [];
  console.log(`[reembed] re-embedding with concurrency=${CONCURRENCY}...`);
  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    const batch = rows.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(async (row) => {
        if (!row.content.trim()) {
          skipped++;
          return;
        }
        try {
          await embedOne(row);
          ok++;
        } catch (err) {
          failures.push(row);
          console.error(`[reembed] failed (will retry) ${row.id}: ${(err as Error).message}`);
        }
      }),
    );
    if ((i / CONCURRENCY) % 25 === 0 || i + CONCURRENCY >= rows.length) {
      console.log(`[reembed] progress ${Math.min(i + CONCURRENCY, rows.length)}/${rows.length} (ok=${ok}, pending-retry=${failures.length})`);
    }
  }

  // 3b. Straggler pass — retry every failure SERIALLY with a pause. Guarantees
  // completeness: leaving any node with its zero vector would silently break recall
  // for that node, which is the exact failure mode this migration exists to kill.
  let stillFailed = 0;
  if (failures.length > 0) {
    console.log(`[reembed] straggler pass: retrying ${failures.length} failures serially...`);
    for (const row of failures) {
      let done = false;
      for (let attempt = 1; attempt <= 5 && !done; attempt++) {
        try {
          await embedOne(row);
          ok++;
          done = true;
        } catch (err) {
          await new Promise((r) => setTimeout(r, 500 * attempt));
          if (attempt === 5) {
            stillFailed++;
            console.error(`[reembed] PERMANENT FAIL ${row.id}: ${(err as Error).message}`);
          }
        }
      }
    }
  }

  // 4. Recreate the index at the new dimension (builds from the written vectors).
  console.log(`[reembed] recreating vector index at dim ${EMBEDDING_DIM}...`);
  await createVectorIndex();

  console.log(
    `[reembed] DONE — ${ok} re-embedded, ${skipped} skipped (empty), ${stillFailed} permanent failures`,
  );
  await closeGraph();

  if (stillFailed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("[reembed] fatal:", err);
  process.exit(1);
});
