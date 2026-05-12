#!/usr/bin/env bun
/**
 * Phase 1E backfill migration: stamp every legacy Episode/Thought/Entity/Anchor
 * with `tenant_user_id = GOBOT_DEFAULT_USER_ID` (Kyle's Convex `users` _id).
 *
 * Pre-Phase-1E the graph was single-tenant by design — no nodes had
 * tenant fields. After Phase 1E lands, recall queries filter by
 * tenant_user_id, so untagged legacy nodes become invisible. This
 * one-shot script tags them all with Kyle's userId so the existing
 * graph behaviour continues unchanged.
 *
 * Idempotent: skips nodes that already have a tenant_user_id.
 *
 * Run via:
 *   GOBOT_DEFAULT_USER_ID=<kyle-id> bun run scripts/migrate-add-tenant.ts
 *
 * IMPORTANT: must be run AGAINST THE LIVE GRAPH while the service is
 * up — the script does NOT call initGraph (which would compete for
 * the FalkorDB lock). Instead it opens a separate process — but since
 * FalkorDBLite holds the lock, run this only ONE OF:
 *
 *   (a) Stop the live service: `launchctl unload ~/Library/LaunchAgents/com.speki.mimir.plist`
 *       then run this script, then start the service back up.
 *   (b) Add a privileged /api/admin/backfill-tenant endpoint inside the
 *       service that calls applyTenantBackfill (the function exported
 *       below) — preferable for zero-downtime cutover.
 *
 * For Catherine pilot's cutover, plan (a) is acceptable (~30s downtime).
 */

import { initGraph, closeGraph, getGraph } from "../src/graph.js";

const DATA_PATH =
  process.env.MIMIR_DATA_PATH || "/Volumes/AI-Lab/falkordb-data/personal-brain";

export interface BackfillResult {
  episodes: number;
  thoughts: number;
  entities: number;
  anchors: number;
  durationMs: number;
}

/**
 * Stamp all untagged Episode/Thought/Entity/Anchor nodes with the given
 * fallback userId. Idempotent — skips already-stamped nodes.
 *
 * Returns counts per label for audit logging.
 */
export async function applyTenantBackfill(defaultUserId: string): Promise<BackfillResult> {
  if (!defaultUserId) {
    throw new Error(
      "applyTenantBackfill: defaultUserId is required (no anonymous tagging).",
    );
  }
  const g = getGraph();
  const startedAt = Date.now();

  // Episode
  const epResult = await g.query(
    `MATCH (ep:Episode)
     WHERE ep.tenant_user_id IS NULL
     SET ep.tenant_user_id = $userId
     RETURN count(ep) AS affected`,
    { params: { userId: defaultUserId } },
  );
  const episodes =
    ((epResult.data?.[0] as Record<string, unknown>)?.affected as number) ?? 0;

  // Thought
  const thResult = await g.query(
    `MATCH (t:Thought)
     WHERE t.tenant_user_id IS NULL
     SET t.tenant_user_id = $userId
     RETURN count(t) AS affected`,
    { params: { userId: defaultUserId } },
  );
  const thoughts =
    ((thResult.data?.[0] as Record<string, unknown>)?.affected as number) ?? 0;

  // Entity
  const enResult = await g.query(
    `MATCH (e:Entity)
     WHERE e.tenant_user_id IS NULL
     SET e.tenant_user_id = $userId
     RETURN count(e) AS affected`,
    { params: { userId: defaultUserId } },
  );
  const entities =
    ((enResult.data?.[0] as Record<string, unknown>)?.affected as number) ?? 0;

  // Anchor
  const anResult = await g.query(
    `MATCH (a:Anchor)
     WHERE a.tenant_user_id IS NULL
     SET a.tenant_user_id = $userId
     RETURN count(a) AS affected`,
    { params: { userId: defaultUserId } },
  );
  const anchors =
    ((anResult.data?.[0] as Record<string, unknown>)?.affected as number) ?? 0;

  // Fact edges: also stamp those (they're invisible otherwise).
  // The relationship MATCH doesn't carry a label restriction, so we
  // stamp ALL fact-bearing edges (those with r.fact IS NOT NULL).
  const edgeResult = await g.query(
    `MATCH ()-[r]->()
     WHERE r.tenant_user_id IS NULL AND r.fact IS NOT NULL
     SET r.tenant_user_id = $userId
     RETURN count(r) AS affected`,
    { params: { userId: defaultUserId } },
  );
  const edges =
    ((edgeResult.data?.[0] as Record<string, unknown>)?.affected as number) ?? 0;
  console.log(`[mimir:migrate] fact-edges stamped: ${edges}`);

  return {
    episodes,
    thoughts,
    entities,
    anchors,
    durationMs: Date.now() - startedAt,
  };
}

// ─── CLI entry point ────────────────────────────────────────

async function main() {
  const defaultUserId = process.env.GOBOT_DEFAULT_USER_ID ?? "";
  if (!defaultUserId) {
    console.error(
      "[mimir:migrate-add-tenant] GOBOT_DEFAULT_USER_ID is required. " +
      "Set it to Kyle's Convex `users` _id (look up via `npx convex run users:list` " +
      "or read the existing .env in gobot).",
    );
    process.exit(1);
  }

  console.log(`[mimir:migrate-add-tenant] data path: ${DATA_PATH}`);
  console.log(`[mimir:migrate-add-tenant] default userId: ${defaultUserId}`);
  console.log("[mimir:migrate-add-tenant] initializing graph (will fail if service is running)...");

  await initGraph(DATA_PATH);
  console.log("[mimir:migrate-add-tenant] graph initialized; running backfill...");

  const result = await applyTenantBackfill(defaultUserId);
  console.log("[mimir:migrate-add-tenant] backfill complete:");
  console.log(`  Episodes:  ${result.episodes}`);
  console.log(`  Thoughts:  ${result.thoughts}`);
  console.log(`  Entities:  ${result.entities}`);
  console.log(`  Anchors:   ${result.anchors}`);
  console.log(`  Duration:  ${result.durationMs}ms`);

  await closeGraph();
  console.log("[mimir:migrate-add-tenant] done; graph lock released. Restart service.");
}

// Only run when invoked directly.
if (import.meta.path === Bun.main) {
  main().catch((err) => {
    console.error("[mimir:migrate-add-tenant] FATAL:", err);
    process.exit(1);
  });
}
