#!/usr/bin/env bun
/**
 * Migrate FalkorDB graph name from mosscap_brain to mimir.
 *
 * FalkorDBLite stores graphs by name. The old code used "mosscap_brain",
 * the new Mimir code uses "mimir". This script copies all nodes and edges
 * from the old graph to the new one.
 *
 * Usage: bun run scripts/migrate-graph-name.ts [--dry-run]
 */

import { FalkorDB } from "falkordblite";

const DATA_PATH = process.env.MIMIR_DATA_PATH || "/Volumes/AI-Lab/falkordb-data/personal-brain";
const DRY_RUN = process.argv.includes("--dry-run");

async function main() {
  console.log(`[migrate] Data path: ${DATA_PATH}`);
  console.log(`[migrate] Mode: ${DRY_RUN ? "DRY RUN" : "LIVE"}`);

  const db = await FalkorDB.open({ path: DATA_PATH });

  const oldGraph = db.selectGraph("mosscap_brain");
  const newGraph = db.selectGraph("mimir");

  // Check if old graph has data
  let oldNodeCount = 0;
  try {
    const countResult = await oldGraph.query("MATCH (n) RETURN count(n) AS cnt");
    oldNodeCount = countResult.data
      ? ((countResult.data[0] as Record<string, unknown>)?.cnt as number) || 0
      : 0;
  } catch {
    console.log("[migrate] Old graph 'mosscap_brain' has no data or doesn't exist.");
    await db.close();
    return;
  }

  console.log(`[migrate] Old graph 'mosscap_brain' has ${oldNodeCount} nodes`);

  if (oldNodeCount === 0) {
    console.log("[migrate] Nothing to migrate.");
    await db.close();
    return;
  }

  // Check if new graph already has data
  let newNodeCount = 0;
  try {
    const countResult = await newGraph.query("MATCH (n) RETURN count(n) AS cnt");
    newNodeCount = countResult.data
      ? ((countResult.data[0] as Record<string, unknown>)?.cnt as number) || 0
      : 0;
  } catch {
    // New graph doesn't exist yet — that's expected
  }

  if (newNodeCount > 0) {
    console.log(`[migrate] New graph 'mimir' already has ${newNodeCount} nodes. Skipping to avoid duplicates.`);
    await db.close();
    return;
  }

  if (DRY_RUN) {
    // Show what would be migrated
    const nodesResult = await oldGraph.query(
      "MATCH (n) RETURN labels(n) AS labels, n.id AS id, n.content AS content LIMIT 20"
    );
    console.log("\n[migrate] Nodes to migrate:");
    for (const row of (nodesResult.data || []) as Record<string, unknown>[]) {
      const content = (row.content as string)?.slice(0, 60) || "(no content)";
      console.log(`  - ${row.labels}: ${content}`);
    }

    const edgesResult = await oldGraph.query(
      "MATCH ()-[r]->() RETURN type(r) AS type, count(r) AS cnt"
    );
    console.log("\n[migrate] Edge types:");
    for (const row of (edgesResult.data || []) as Record<string, unknown>[]) {
      console.log(`  - ${row.type}: ${row.cnt}`);
    }

    console.log("\n[migrate] DRY RUN — no changes made.");
    await db.close();
    return;
  }

  // Use COPY — dump all nodes from old, recreate in new
  // FalkorDBLite doesn't have a rename command, so we export/import via Cypher

  // Step 1: Get all nodes with their labels and properties
  console.log("[migrate] Exporting nodes from mosscap_brain...");

  // Export each node type separately since FalkorDB returns properties differently
  for (const label of ["Entity", "Thought", "Anchor", "Episode"]) {
    const nodesResult = await oldGraph.query(
      `MATCH (n:${label}) RETURN properties(n) AS props`
    );

    if (!nodesResult.data || nodesResult.data.length === 0) continue;

    console.log(`[migrate] Copying ${nodesResult.data.length} ${label} nodes...`);

    for (const row of nodesResult.data as Record<string, unknown>[]) {
      const props = row.props as Record<string, unknown>;
      if (!props) continue;

      // Build SET clause from properties
      const setParts: string[] = [];
      const params: Record<string, unknown> = {};

      for (const [key, value] of Object.entries(props)) {
        if (value === null || value === undefined) continue;
        if (Array.isArray(value) && typeof value[0] === "number" && value.length > 100) {
          // Vector — use vecf32
          setParts.push(`n.${key} = vecf32($${key})`);
        } else {
          setParts.push(`n.${key} = $${key}`);
        }
        params[key] = value;
      }

      if (setParts.length === 0) continue;

      await newGraph.query(
        `CREATE (n:${label}) SET ${setParts.join(", ")}`,
        { params },
      );
    }
  }

  // Step 2: Recreate edges
  console.log("[migrate] Exporting edges...");
  const edgesResult = await oldGraph.query(
    `MATCH (a)-[r]->(b)
     RETURN labels(a)[0] AS fromLabel, a.id AS fromId,
            labels(b)[0] AS toLabel, b.id AS toId,
            type(r) AS edgeType, properties(r) AS props`
  );

  if (edgesResult.data && edgesResult.data.length > 0) {
    console.log(`[migrate] Copying ${edgesResult.data.length} edges...`);

    for (const row of edgesResult.data as Record<string, unknown>[]) {
      const fromLabel = row.fromLabel as string;
      const fromId = row.fromId as string;
      const toLabel = row.toLabel as string;
      const toId = row.toId as string;
      const edgeType = row.edgeType as string;
      const props = (row.props as Record<string, unknown>) || {};

      const setParts: string[] = [];
      const params: Record<string, unknown> = { fromId, toId };

      for (const [key, value] of Object.entries(props)) {
        if (value === null || value === undefined) continue;
        setParts.push(`${key}: $${key}`);
        params[key] = value;
      }

      const propsStr = setParts.length > 0 ? ` {${setParts.join(", ")}}` : "";

      try {
        await newGraph.query(
          `MATCH (a:${fromLabel} {id: $fromId}), (b:${toLabel} {id: $toId})
           CREATE (a)-[:${edgeType}${propsStr}]->(b)`,
          { params },
        );
      } catch (err: any) {
        console.error(`  ✗ Failed edge ${fromId} -[${edgeType}]-> ${toId}: ${err.message}`);
      }
    }
  }

  // Step 3: Create indexes on new graph
  console.log("[migrate] Creating indexes...");
  await newGraph.query("CREATE INDEX FOR (e:Entity) ON (e.name)").catch(() => {});
  await newGraph.query("CREATE INDEX FOR (t:Thought) ON (t.created_at)").catch(() => {});
  await newGraph.query("CREATE INDEX FOR (a:Anchor) ON (a.domain)").catch(() => {});
  await newGraph.query("CREATE INDEX FOR (ep:Episode) ON (ep.timestamp)").catch(() => {});
  await newGraph.query(
    "CREATE VECTOR INDEX FOR (t:Thought) ON (t.embedding) OPTIONS {dimension: 1536, similarityFunction: 'cosine'}"
  ).catch(() => {});

  // Verify
  const verifyResult = await newGraph.query("MATCH (n) RETURN count(n) AS cnt");
  const newCount = verifyResult.data
    ? ((verifyResult.data[0] as Record<string, unknown>)?.cnt as number) || 0
    : 0;

  console.log(`\n[migrate] Done. New graph 'mimir' has ${newCount} nodes (was ${oldNodeCount} in old graph).`);
  await db.close();
}

main().catch((err) => {
  console.error("[migrate] Fatal error:", err);
  process.exit(1);
});
