/**
 * Mimir box tiebreaker test (Fable 5 review, brief-01 gap; synthesis 10 §"The
 * Mimir tiebreaker test can't see its own bug").
 *
 * WHY THIS EXISTS: a latency/queue-depth load test passes on a quiet Mac, then
 * production fails when the background consolidation worker collides with a
 * live recall — and recall CORRECTNESS degrades silently around the over-fetch
 * window (initial window = min(max(k*20, 256), 1000), src/graph.ts:595 — a
 * wrong-neighbors bug latency cannot detect). This harness (a) asserts recall
 * correctness against exact brute-force ground truth at 500 / 1000 / 1530+
 * nodes, (b) observes the over-fetch-window behavior directly, and (c) runs
 * the REAL consolidation worker loop (verbs/process-queue.ts processQueue())
 * concurrently with recall probes, asserting zero errors + intact correctness
 * and capturing the latency delta. Output feeds the refactor-vs-box decision.
 *
 * ── SAFETY (child-safety-adjacent production service) ──────────────────────
 * The live Mimir service (launchd com.speki.mimir, localhost:4200) and its
 * FalkorDB data at /Volumes/AI-Lab/falkordb-data/personal-brain are NEVER
 * touched. This harness runs IN-PROCESS against its own throwaway
 * falkordblite instance under /tmp/zztest-tiebreaker-* (initGraph requires an
 * explicit dataPath precisely to prevent cross-Brain writes — graph.ts:55).
 * Guards below hard-fail if the path looks like production. The instance is
 * deleted and deletion is VERIFIED as the final test. BRAIN_DISABLE_LLM=true
 * is set as defense-in-depth so no code path can reach a real LLM even if the
 * extraction mock fails to attach (extraction.ts:420 checks it first).
 * The only permitted network call is one read-only local oMLX reachability
 * probe + query embeddings for full-verb recall() integration probes ($0,
 * same precedent as src/__tests__/scale-correctness.dive.test.ts).
 *
 * RUN:  bun test test/tiebreaker/tiebreaker.test.ts
 * (Targeted run recommended; under a full `bun test` the extraction mock is
 * restored in afterAll so sibling suites see the real module.)
 */

import { describe, test, expect, beforeAll, afterAll, mock } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

// Defense-in-depth BEFORE any src import: even if the extraction mock fails
// to attach, extractFromText defers instead of calling an LLM.
const ORIGINAL_DISABLE_LLM = process.env.BRAIN_DISABLE_LLM;
process.env.BRAIN_DISABLE_LLM = "true";

import {
  initGraph,
  closeGraph,
  getGraph,
  createNode,
} from "../../src/graph.js";
import { recall } from "../../src/verbs/recall.js";
import { generateEmbedding } from "../../src/embeddings.js";
import { vectorSearch } from "../../src/graph.js";
import type { TenantStamp, TenantFilter } from "../../src/types.js";
import {
  DIM,
  NUM_CLUSTERS,
  mulberry32,
  nearAxis,
  basisAxis,
  buildPhaseRows,
  bruteForceTopK,
  pct,
  fmtMs,
  type ThoughtRow,
  type GroundTruthEntry,
} from "./fixtures.js";

// ─── Throwaway instance path + hard safety guards ───────────────────────────

const DATE_TAG = "2026-07-06";
const TEST_DATA_PATH = `/tmp/zztest-tiebreaker-${DATE_TAG}-${process.pid}`;
const OUT_DIR = path.join(import.meta.dir, "out");

{
  const FORBIDDEN = ["falkordb-data", "personal-brain", "AI-Lab"];
  for (const f of FORBIDDEN) {
    if (TEST_DATA_PATH.includes(f)) {
      throw new Error(`SAFETY: test data path '${TEST_DATA_PATH}' touches forbidden segment '${f}'`);
    }
  }
  if (!TEST_DATA_PATH.startsWith("/tmp/zztest-tiebreaker-")) {
    throw new Error(`SAFETY: test data path must live under /tmp/zztest-tiebreaker-*`);
  }
  if (fs.existsSync(TEST_DATA_PATH)) {
    throw new Error(`SAFETY: ${TEST_DATA_PATH} already exists — refusing to reuse state`);
  }
}

// ─── Tenants + probes ────────────────────────────────────────────────────────

const CALLER = "tiebreaker_caller";
const DECOY = "tiebreaker_decoy";
const CALLER_FILTER: TenantFilter = { callerUserId: CALLER };
const DECOY_FILTER: TenantFilter = { callerUserId: DECOY };

// Probe vectors are fixture constants (own PRNG stream, independent of
// seeding order): one per cluster at cosine ~0.985 to the cluster axis.
const probeRng = mulberry32(1234);
const PROBES: number[][] = Array.from({ length: NUM_CLUSTERS }, (_, c) =>
  nearAxis(basisAxis(c), 0.985, probeRng),
);

// ─── Shared run state ────────────────────────────────────────────────────────

const SIZES = [500, 1000, 1530] as const;
let callerRows: ThoughtRow[] = []; // caller-visible rows seeded so far (ground-truth basis)
const groundTruthBySize = new Map<number, GroundTruthEntry[]>();
const metrics: Record<string, unknown> = {
  data_path: TEST_DATA_PATH,
  seed_note: "mulberry32 seeds: rows=42, probes=1234; ids structured tb-cXX-mYYY-pN",
};
let omlxReachable = false;

let unwindWorks: boolean | null = null;
async function seedThoughts(rows: ThoughtRow[]): Promise<void> {
  const g = getGraph();
  const BATCH = 100;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    if (unwindWorks !== false) {
      try {
        await g.query(
          `UNWIND $rows AS row
           CREATE (t:Thought {id: row.id, content: row.content, source: 'chat',
                              confidence: 0.9, created_at: row.created_at,
                              tenant_user_id: row.tenant})
           SET t.embedding = vecf32(row.embedding)`,
          { params: { rows: batch } },
        );
        unwindWorks = true;
        continue;
      } catch (err) {
        console.error(`[tiebreaker] UNWIND unavailable (${(err as Error).message}) — per-node fallback`);
        unwindWorks = false;
      }
    }
    for (const r of batch) {
      await createNode(
        "Thought",
        { id: r.id, content: r.content, embedding: r.embedding, source: "chat", confidence: 0.9, created_at: r.created_at },
        { userId: r.tenant },
      );
    }
  }
}

/** One correctness probe: rank-#1 + top-5 set vs exact ground truth. */
async function probeCluster(
  c: number,
  gt: GroundTruthEntry[],
): Promise<{ ms: number; rank1Ok: boolean; top5Ok: boolean; tenantOk: boolean; got: string[] }> {
  const t0 = performance.now();
  const results = await vectorSearch(PROBES[c], 10, CALLER_FILTER);
  const ms = performance.now() - t0;
  const expected = gt[c].expected.map((e) => e.id);
  const got = results.map((r) => r.id);
  return {
    ms,
    // feedback_verify_recall_by_content_rank: the RIGHT known item must rank #1
    rank1Ok: got[0] === expected[0],
    top5Ok:
      got.length >= 5 &&
      [...got.slice(0, 5)].sort().join("|") === [...expected].sort().join("|"),
    tenantOk: results.every((r) => r.tenant_user_id === CALLER),
    got: got.slice(0, 5),
  };
}

function computeGroundTruth(size: number): GroundTruthEntry[] {
  const entries: GroundTruthEntry[] = [];
  for (let c = 0; c < NUM_CLUSTERS; c++) {
    const { expected, margin } = bruteForceTopK(PROBES[c], callerRows, 5);
    entries.push({ cluster: c, expected, margin });
  }
  groundTruthBySize.set(size, entries);
  return entries;
}

async function assertSweep(size: number, gt: GroundTruthEntry[]): Promise<number[]> {
  const lat: number[] = [];
  for (let c = 0; c < NUM_CLUSTERS; c++) {
    const p = await probeCluster(c, gt);
    lat.push(p.ms);
    if (!p.rank1Ok || !p.top5Ok || !p.tenantOk) {
      console.error(
        `[tiebreaker] size=${size} cluster=${c} FAILED rank1=${p.rank1Ok} top5=${p.top5Ok} tenant=${p.tenantOk} ` +
          `expected=${gt[c].expected.map((e) => e.id).join(",")} got=${p.got.join(",")}`,
      );
    }
    expect(p.tenantOk).toBe(true);
    expect(p.rank1Ok).toBe(true);
    expect(p.top5Ok).toBe(true);
  }
  console.error(`[tiebreaker] sweep size=${size}: 30/30 clusters correct | ${fmtMs(lat)}`);
  return lat;
}

// ─── Suite ───────────────────────────────────────────────────────────────────

describe("Mimir box tiebreaker — correctness past the over-fetch window + consolidation contention", () => {
  beforeAll(async () => {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    await initGraph(TEST_DATA_PATH);

    // Read-only local reachability probe (embeddings only; $0; never fatal).
    try {
      const v = await generateEmbedding("tiebreaker reachability probe");
      omlxReachable = v.length === DIM;
    } catch {
      omlxReachable = false;
    }
    metrics.omlx_reachable = omlxReachable;
    console.error(`[tiebreaker] isolated instance at ${TEST_DATA_PATH} | oMLX reachable=${omlxReachable}`);
  }, 120_000);

  afterAll(async () => {
    // Safety net if a phase died mid-way: close + remove. Phase E is the
    // asserted, verified cleanup; this is best-effort backup.
    try {
      await closeGraph();
    } catch {}
    fs.rmSync(TEST_DATA_PATH, { recursive: true, force: true });
    // Suite citizenship: restore the env exactly as found.
    if (ORIGINAL_DISABLE_LLM === undefined) delete process.env.BRAIN_DISABLE_LLM;
    else process.env.BRAIN_DISABLE_LLM = ORIGINAL_DISABLE_LLM;
  });

  // ── Phase A — correctness sweep at 500 / 1000 / 1530 nodes ────────────────
  test("Phase A — recall@top5 exact at 500, 1000, 1530 nodes (rank-#1 asserted)", async () => {
    const rng = mulberry32(42);
    const now = Date.now();
    const sweepLat: Record<string, number[]> = {};

    // size 500 = 30×16 members (5 designed TARGETS + 11 background) + 20 filler.
    // The 5 targets per cluster are the known ground-truth top-5 at EVERY
    // size — growth must not displace them.
    const p1 = buildPhaseRows({ phase: "p1", tenant: CALLER, membersPerCluster: 16, memberOffset: 0, targetsPerCluster: 5, filler: 20, rng, now });
    await seedThoughts(p1);
    callerRows.push(...p1);
    expect(callerRows.length).toBe(500);
    sweepLat["500"] = await assertSweep(500, computeGroundTruth(500));

    // size 1000 = +30×16 + 20 filler
    const p2 = buildPhaseRows({ phase: "p2", tenant: CALLER, membersPerCluster: 16, memberOffset: 16, filler: 20, rng, now });
    await seedThoughts(p2);
    callerRows.push(...p2);
    expect(callerRows.length).toBe(1000);
    sweepLat["1000"] = await assertSweep(1000, computeGroundTruth(1000));

    // size 1530 = +30×17 + 20 filler (past the 1000 initial-window ceiling)
    const p3 = buildPhaseRows({ phase: "p3", tenant: CALLER, membersPerCluster: 17, memberOffset: 32, filler: 20, rng, now });
    await seedThoughts(p3);
    callerRows.push(...p3);
    expect(callerRows.length).toBe(1530);
    sweepLat["1530"] = await assertSweep(1530, computeGroundTruth(1530));

    metrics.phaseA_sweep_latency = Object.fromEntries(
      Object.entries(sweepLat).map(([k, v]) => [k, { p50: pct(v, 50), p95: pct(v, 95) }]),
    );
    fs.writeFileSync(
      path.join(OUT_DIR, "ground-truth.json"),
      JSON.stringify(
        SIZES.map((s) => ({ size: s, entries: groundTruthBySize.get(s) })),
        null,
        2,
      ),
    );
  }, 300_000);

  // ── Phase B — over-fetch-window behavior, observed directly ───────────────
  test("Phase B — 1100 closer other-tenant vectors: fixed 256/1000 windows starve; escalation stays correct", async () => {
    const g = getGraph();
    const rng = mulberry32(77);
    const now = Date.now();

    // 1100 decoy-tenant thoughts at cosine ~0.995 to cluster-0's axis — ALL
    // closer to the cluster-0 probe (0.985·0.995 ≈ 0.980) than every one of
    // the caller's own cluster-0 members (≤ 0.965·0.985 ≈ 0.951).
    const decoys: ThoughtRow[] = [];
    for (let i = 0; i < 1100; i++) {
      decoys.push({
        id: `tb-decoy-${String(i).padStart(4, "0")}`,
        content: `decoy ${i} another tenant's near-duplicate note on the shared topic`,
        created_at: now,
        tenant: DECOY,
        embedding: nearAxis(basisAxis(0), 0.995, rng),
      });
    }
    await seedThoughts(decoys);

    // Raw window occupancy — what a FIXED window (no escalation) actually sees.
    async function callerInWindow(k: number): Promise<number> {
      const res = await g.query(
        `CALL db.idx.vector.queryNodes('Thought', 'embedding', $k, vecf32($e))
         YIELD node, score
         RETURN node.tenant_user_id AS t
         ORDER BY score ASC`,
        { params: { k, e: PROBES[0] } },
      );
      return ((res.data ?? []) as Array<{ t: string }>).filter((r) => r.t === CALLER).length;
    }
    const in256 = await callerInWindow(256); // the k=10 initial window
    const in1000 = await callerInWindow(1000); // the former hard ceiling
    console.error(
      `[tiebreaker:B] caller nodes in raw candidate window: k=256 → ${in256}, k=1000 → ${in1000} ` +
        `(1100 decoys closer than all caller members)`,
    );
    metrics.phaseB_window_occupancy = { caller_in_256: in256, caller_in_1000: in1000, decoys: 1100 };

    // With 1100 strictly-closer decoys, the exact top-256 and top-1000 contain
    // ZERO caller nodes; the ANN may let a stray one or two through, but a
    // fixed window MUST be starved below top-5 sufficiency — the silent
    // wrong/empty-neighbors regime the synthesis warned about
    // (pre-2026-07-02 behavior, before the escalation loop).
    expect(in256).toBeLessThan(5);
    expect(in1000).toBeLessThan(5);

    // The escalating vectorSearch (graph.ts:595 window, :667 fetchK*=4) must
    // still return the caller's exact top-5, at a measurable latency cost.
    const gt = groundTruthBySize.get(1530)!;
    const crowdedLat: number[] = [];
    for (let i = 0; i < 15; i++) {
      const p = await probeCluster(0, gt);
      crowdedLat.push(p.ms);
      expect(p.rank1Ok).toBe(true);
      expect(p.top5Ok).toBe(true);
      expect(p.tenantOk).toBe(true);
    }
    const uncrowdedLat: number[] = [];
    for (let i = 0; i < 15; i++) {
      const p = await probeCluster(5, gt); // cluster 5 has no decoys
      uncrowdedLat.push(p.ms);
      expect(p.rank1Ok).toBe(true);
      expect(p.top5Ok).toBe(true);
    }
    console.error(
      `[tiebreaker:B] escalated (crowded) ${fmtMs(crowdedLat)} vs first-window (uncrowded) ${fmtMs(uncrowdedLat)}`,
    );
    metrics.phaseB_latency = {
      crowded_escalated: { p50: pct(crowdedLat, 50), p95: pct(crowdedLat, 95) },
      uncrowded_first_window: { p50: pct(uncrowdedLat, 50), p95: pct(uncrowdedLat, 95) },
    };
  }, 300_000);

  // ── Phase C — REAL consolidation worker loop vs live recall probes ────────
  test("Phase C — processQueue() contention: zero errors, correctness intact, latency delta captured", async () => {
    // Mock ONLY the LLM extraction call with deterministic canned output —
    // processQueue() then executes its full real write pattern
    // (findEntityByName → createNode/updateEntitySummary → involves edges →
    // createFactEdge → resolveContradictions → SET processed) against this
    // graph. No LLM latency between writes ⇒ HARSHER than the production
    // 30s-interval loop (service.ts:726-748).
    const realExtraction = await import("../../src/extraction.js");
    mock.module("../../src/extraction.js", () => ({
      ...realExtraction,
      extractFromText: async (content: string) => {
        const m = content.match(/tb-ep-(\d+)/);
        const i = m ? parseInt(m[1], 10) : 0;
        const a = `Topic ${i % 12}`;
        const b = `Topic ${(i + 5) % 12}`;
        return {
          entities: [
            { name: a, type: "concept" },
            { name: b, type: "concept" },
          ],
          entity_actions: [
            { name: a, type: "concept", fact_summary: `Summary of ${a} as of episode ${i}`, action: i % 3 === 0 ? "UPDATE" : "ADD" },
            { name: b, type: "concept", fact_summary: `Summary of ${b} as of episode ${i}`, action: "ADD" },
          ],
          relationships: [],
          facts: [
            { from: a, to: b, edge_type: "relates_to", fact: `${a} relates to ${b} per episode ${i}`, valid_at: null, invalid_at: null },
          ],
          is_anchor: false,
          anchor_domain: null,
          commitment: null,
          deadline: null,
          confidence: 0.9,
          domains: ["tiebreaker"],
        };
      },
    }));
    // Import AFTER the mock so process-queue.js binds the mocked extraction.
    const { processQueue } = await import("../../src/verbs/process-queue.js");

    // Seed 180 unprocessed Episodes across both tenants, varied source_type
    // (voice 0.9 / chat 0.85 / email 0.7 authority ⇒ exercises the
    // contradiction-resolution belief updates too).
    const g = getGraph();
    const now = Date.now();
    const sourceTypes = ["voice", "chat", "email"];
    const episodeIds: string[] = [];
    for (let i = 0; i < 180; i++) {
      const id = await createNode(
        "Episode",
        {
          content: `tb-ep-${i} synthetic class recap: students worked on topic ${i % 12}`,
          source_type: sourceTypes[i % 3],
          participants: [],
          timestamp: now + i,
          event_at: now + i,
          processed: false,
        },
        { userId: i % 3 === 0 ? CALLER : DECOY },
      );
      episodeIds.push(id);
    }

    const gt = groundTruthBySize.get(1530)!;

    // Quiet baseline on the SAME graph state (post-Phase-B).
    const quietPre: number[] = [];
    for (let p = 0; p < 60; p++) {
      const c = p % NUM_CLUSTERS;
      if (c === 0) continue; // crowded cluster measured separately in Phase B
      const r = await probeCluster(c, gt);
      quietPre.push(r.ms);
      expect(r.rank1Ok).toBe(true);
      expect(r.top5Ok).toBe(true);
    }

    // ── The real worker loop, back-to-back passes (interval → 0) ──
    let probesDone = false;
    let workerErrors = 0;
    let rearms = 0;
    const totals = { processed: 0, failed: 0, skipped: 0, passes: 0 };
    const retainAnalogRows: ThoughtRow[] = [];
    let retainAnalogOn = false;
    const retainRng = mulberry32(555);
    const worker = (async () => {
      while (!probesDone) {
        try {
          const r = await processQueue(10); // production batch size (service.ts:729)
          totals.passes++;
          totals.processed += r.processed;
          totals.failed += r.failed;
          totals.skipped += r.skipped;
          if (r.processed === 0 && r.failed === 0) {
            // Queue drained — re-arm 60 episodes (new work arriving, as the
            // production ~30s cadence would keep doing).
            rearms++;
            await g.query(
              `MATCH (ep:Episode) WHERE ep.id IN $ids SET ep.processed = false`,
              { params: { ids: episodeIds.slice(0, 60) } },
            );
          }
          if (retainAnalogOn) {
            // MIMIR_FAST_RETAIN analog: production also inserts embedded
            // Thoughts inline while the worker runs. Random-direction caller
            // vectors (cos ~0 to every probe; ground-truth margins ≥0.8 are
            // unaffected) — this mutates the vector index DURING reads.
            const batch: ThoughtRow[] = [];
            for (let j = 0; j < 5; j++) {
              batch.push({
                id: `tb-retain-${retainAnalogRows.length + j}`,
                content: `retain-analog inline write ${retainAnalogRows.length + j}`,
                created_at: Date.now(),
                tenant: CALLER,
                embedding: (function () {
                  const v = new Array(DIM);
                  for (let d = 0; d < DIM; d++) v[d] = retainRng() * 2 - 1;
                  let s = 0;
                  for (const x of v) s += x * x;
                  const n = Math.sqrt(s) || 1;
                  return v.map((x: number) => x / n);
                })(),
              });
            }
            await seedThoughts(batch);
            retainAnalogRows.push(...batch);
          }
        } catch (err) {
          workerErrors++;
          console.error(`[tiebreaker:C] worker pass error: ${(err as Error).message}`);
        }
      }
    })();

    // C1 — contended probes, worker-only.
    const contended: number[] = [];
    const recallLat: number[] = [];
    let recallErrors = 0;
    let wrongNeighborProbes = 0;
    for (let p = 0; p < 60; p++) {
      const c = 1 + (p % (NUM_CLUSTERS - 1));
      const r = await probeCluster(c, gt);
      contended.push(r.ms);
      if (!r.rank1Ok || !r.top5Ok) wrongNeighborProbes++;
      if (p % 10 === 9) {
        // Full-verb integration probe (semantic+graph+anchor merge, hydration).
        const t0 = performance.now();
        try {
          const res = await recall(`probe-token-cluster-${String(c).padStart(2, "0")}`, CALLER_FILTER);
          recallLat.push(performance.now() - t0);
          expect(res.results.length).toBeGreaterThan(0);
        } catch (err) {
          recallErrors++;
          console.error(`[tiebreaker:C] recall() error: ${(err as Error).message}`);
        }
      }
    }

    // C2 — contended probes, worker + retain-analog inline vector writes.
    retainAnalogOn = true;
    const contendedRetain: number[] = [];
    for (let p = 0; p < 60; p++) {
      const c = 1 + (p % (NUM_CLUSTERS - 1));
      const r = await probeCluster(c, gt);
      contendedRetain.push(r.ms);
      if (!r.rank1Ok || !r.top5Ok) wrongNeighborProbes++;
    }

    probesDone = true;
    await worker;

    // Quiet-post re-sweep: worker writes must not have corrupted the index.
    const quietPost: number[] = [];
    for (let p = 0; p < 60; p++) {
      const c = 1 + (p % (NUM_CLUSTERS - 1));
      const r = await probeCluster(c, gt);
      quietPost.push(r.ms);
      expect(r.rank1Ok).toBe(true);
      expect(r.top5Ok).toBe(true);
    }

    console.error(
      `[tiebreaker:C] worker passes=${totals.passes} processed=${totals.processed} failed=${totals.failed} ` +
        `skipped=${totals.skipped} rearms=${rearms} workerErrors=${workerErrors} | ` +
        `retain-analog thoughts=${retainAnalogRows.length}`,
    );
    console.error(
      `[tiebreaker:C] quiet-pre ${fmtMs(quietPre)} | contended(worker) ${fmtMs(contended)} | ` +
        `contended(worker+retain) ${fmtMs(contendedRetain)} | quiet-post ${fmtMs(quietPost)} | ` +
        `recall() n=${recallLat.length} ${fmtMs(recallLat)} errors=${recallErrors} | ` +
        `wrong-neighbor probes=${wrongNeighborProbes}/120`,
    );
    metrics.phaseC_contention = {
      worker: { ...totals, rearms, workerErrors, retain_analog_thoughts: retainAnalogRows.length },
      latency_ms: {
        quiet_pre: { p50: pct(quietPre, 50), p95: pct(quietPre, 95) },
        contended_worker: { p50: pct(contended, 50), p95: pct(contended, 95) },
        contended_worker_plus_retain: { p50: pct(contendedRetain, 50), p95: pct(contendedRetain, 95) },
        quiet_post: { p50: pct(quietPost, 50), p95: pct(quietPost, 95) },
        recall_verb_contended: { p50: pct(recallLat, 50), p95: pct(recallLat, 95) },
      },
      wrong_neighbor_probes: wrongNeighborProbes,
      recall_errors: recallErrors,
    };

    // (a) zero errors — worker passes, episode processing, and recall() calls.
    expect(workerErrors).toBe(0);
    expect(totals.failed).toBe(0);
    expect(recallErrors).toBe(0);
    // Guard: the mock actually attached (BRAIN_DISABLE_LLM defense would
    // otherwise turn every pass into silent skips and fake a green run).
    expect(totals.processed).toBeGreaterThan(0);
    // (b) correctness held during contention.
    expect(wrongNeighborProbes).toBe(0);

    // Restore the real extraction module for any sibling suites.
    mock.module("../../src/extraction.js", () => realExtraction);
  }, 600_000);

  // ── Phase D — isolation sanity (both directions, benign synthetic data) ───
  test("Phase D — tenant isolation holds under the seeded graph", async () => {
    const callerRes = await vectorSearch(PROBES[0], 10, CALLER_FILTER);
    expect(callerRes.length).toBeGreaterThan(0);
    for (const r of callerRes) expect(r.tenant_user_id).toBe(CALLER);

    const decoyRes = await vectorSearch(PROBES[0], 10, DECOY_FILTER);
    expect(decoyRes.length).toBeGreaterThan(0);
    for (const r of decoyRes) expect(r.tenant_user_id).toBe(DECOY);
  }, 60_000);

  // ── Phase E — verified cleanup of the throwaway instance ──────────────────
  test("Phase E — test graph deleted and deletion verified", async () => {
    fs.writeFileSync(path.join(OUT_DIR, "metrics.json"), JSON.stringify(metrics, null, 2));
    await closeGraph();
    fs.rmSync(TEST_DATA_PATH, { recursive: true, force: true });
    expect(fs.existsSync(TEST_DATA_PATH)).toBe(false);
    // Production data untouched by construction; assert the invariant anyway.
    expect(TEST_DATA_PATH.includes("personal-brain")).toBe(false);
    console.error(`[tiebreaker:E] ${TEST_DATA_PATH} removed — deletion verified`);
  }, 60_000);
});
