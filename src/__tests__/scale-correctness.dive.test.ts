/**
 * Mimir Deep Dive — Q2: Recall CORRECTNESS at classroom scale
 * (fable-mimir-dive, 2026-07-01)
 *
 * The test the synthesis queued but never ran, corrected per
 * 11-corrections C4: there is no literal "1000-node cap" — the real
 * mechanism is vectorSearch's over-fetch window:
 *     overFetchK = min(max(k*20, 256), 1000)      (graph.ts:583)
 * followed by tenant POST-filtering. When other tenants' semantically-
 * similar content crowds the candidate window, the caller's own true
 * neighbors fall past it and recall SILENTLY returns wrong/empty results.
 * At Lighthouse scale (30 users discussing the SAME topics) this is the
 * realistic regime, not an adversarial corner.
 *
 * Parts:
 *   1. Right-neighbors baseline at 3,600+ nodes, 30 tenants (recall@10)
 *   2. Cross-tenant crowding of the over-fetch window (the "box" bug):
 *      recall@10 as a function of crowd size 0 → 1200
 *   3. Positive 30-tenant isolation assertions (Q5 support): sampled
 *      callers see ONLY their own tenant's content (benign synthetic data)
 *   4. Consolidation-worker contention: sustained write storm replicating
 *      process-queue.ts's write pattern, concurrent with recall probes —
 *      assert correctness holds and measure latency delta
 *   5. Unbounded graph-substring strategy: ranking determinacy + latency
 *      when a common word matches hundreds of thoughts (recall.ts:194 has
 *      no LIMIT)
 *
 * SANDBOX: isolated falkordblite instance under /tmp — never the live
 * personal-brain graph. Deterministic seeded vectors; no LLM calls
 * (BRAIN_DISABLE_LLM=true); the only network dependency is local oMLX
 * for recall()'s query embedding in Part 4/5 (read-only, $0).
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  initGraph,
  closeGraph,
  getGraph,
  createNode,
  createEdge,
  findEntityByName,
  vectorSearch,
} from "../graph.js";
import { recall } from "../verbs/recall.js";
import type { TenantStamp, TenantFilter } from "../types.js";

const TEST_DATA_PATH = `/tmp/mimir-dive-scale-${Date.now()}`;
const DIM = 1024;

// ─── Deterministic vector fixtures ──────────────────────────

/** mulberry32 — deterministic PRNG so runs are reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normalize(v: number[]): number[] {
  let s = 0;
  for (const x of v) s += x * x;
  const n = Math.sqrt(s) || 1;
  return v.map((x) => x / n);
}

/** Random unit vector (cos≈0 to any fixed axis). */
function randUnit(rng: () => number): number[] {
  const v = new Array(DIM);
  for (let i = 0; i < DIM; i++) v[i] = rng() * 2 - 1;
  return normalize(v);
}

/** Unit vector at approximately `sim` cosine similarity to `axis`. */
function nearAxis(axis: number[], sim: number, rng: () => number): number[] {
  const noise = randUnit(rng);
  const ortho = normalize(
    noise.map((x, i) => x - axis[i] * noise.reduce((s, y, j) => s + y * axis[j], 0)),
  );
  const b = Math.sqrt(1 - sim * sim);
  return normalize(axis.map((x, i) => sim * x + b * ortho[i]));
}

function basisAxis(idx: number): number[] {
  const v = new Array(DIM).fill(0);
  v[idx] = 1;
  return v;
}

// ─── Batch seeding (UNWIND; falls back to per-node createNode) ──

interface ThoughtRow {
  id: string;
  content: string;
  created_at: number;
  tenant: string;
  embedding: number[];
}

let unwindWorks: boolean | null = null;

async function seedThoughts(rows: ThoughtRow[]): Promise<void> {
  const g = getGraph();
  const BATCH = 100;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH).map((r) => ({
      id: r.id,
      content: r.content,
      created_at: r.created_at,
      tenant: r.tenant,
      embedding: r.embedding,
    }));
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
        console.error(`[dive] UNWIND batch seeding unavailable (${(err as Error).message}) — falling back to per-node createNode`);
        unwindWorks = false;
      }
    }
    for (const r of batch) {
      await createNode(
        "Thought",
        {
          content: r.content,
          embedding: r.embedding,
          source: "chat",
          confidence: 0.9,
          created_at: r.created_at,
        },
        { userId: r.tenant },
      );
    }
  }
}

// ─── Fixture layout ─────────────────────────────────────────

const TENANTS = Array.from({ length: 30 }, (_, i) => `student_${String(i).padStart(2, "0")}`);
const TEACHER = "teacher_01";
const TEACHER_FILTER: TenantFilter = { callerUserId: TEACHER };

// Axis 0: teacher's Part-1 topic. Axis 1: the crowded topic (Part 2).
const AXIS_BASELINE = basisAxis(0);
const AXIS_CROWDED = basisAxis(1);

const TOPICS = [
  "empathy goal reflection",
  "creative writing project",
  "peer collaboration session",
  "math attainment checkpoint",
  "self-directed research",
  "morning meeting notes",
  "studio craftsmanship",
  "reading fluency practice",
  "community service day",
  "agency and initiative",
];

const TARGET_IDS: string[] = [];
const CROWD_TARGET_IDS: string[] = [];

function pct(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

describe("Q2 — recall correctness at classroom scale (isolated instance)", () => {
  beforeAll(async () => {
    await initGraph(TEST_DATA_PATH);
    const rng = mulberry32(42);
    const now = Date.now();

    // 30 tenants × 120 background thoughts = 3600 nodes, random directions.
    const rows: ThoughtRow[] = [];
    for (const tenant of TENANTS) {
      for (let i = 0; i < 120; i++) {
        rows.push({
          id: crypto.randomUUID(),
          content: `Note ${i} about ${TOPICS[i % TOPICS.length]} in ${tenant}'s journal`,
          created_at: now - i * 60_000,
          tenant,
          embedding: randUnit(rng),
        });
      }
    }
    // Teacher's own background content (120 random) …
    for (let i = 0; i < 120; i++) {
      rows.push({
        id: crypto.randomUUID(),
        content: `Teacher planning note ${i} about ${TOPICS[i % TOPICS.length]}`,
        created_at: now - i * 60_000,
        tenant: TEACHER,
        embedding: randUnit(rng),
      });
    }
    // … + 10 TRUE TARGETS near the baseline axis (sim ≈ 0.95).
    for (let i = 0; i < 10; i++) {
      const id = crypto.randomUUID();
      TARGET_IDS.push(id);
      rows.push({
        id,
        content: `TARGET baseline ${i}: Marcus made real progress on his empathy goal today`,
        created_at: now - i * 1000,
        tenant: TEACHER,
        embedding: nearAxis(AXIS_BASELINE, 0.95, rng),
      });
    }
    // + 10 crowd-scenario targets for the teacher near AXIS_CROWDED at
    // sim ≈ 0.80 (relevant, but less close than other tenants' 0.95 crowd).
    for (let i = 0; i < 10; i++) {
      const id = crypto.randomUUID();
      CROWD_TARGET_IDS.push(id);
      rows.push({
        id,
        content: `TARGET crowded ${i}: teacher observation on the shared class topic`,
        created_at: now - i * 1000,
        tenant: TEACHER,
        embedding: nearAxis(AXIS_CROWDED, 0.8, rng),
      });
    }
    await seedThoughts(rows);
    console.error(`[dive] seeded ${rows.length} thoughts across ${TENANTS.length + 1} tenants (UNWIND=${unwindWorks})`);
  }, 300_000);

  afterAll(async () => {
    await closeGraph();
  });

  test("Part 1 — right-neighbors baseline: recall@10 = 10/10 at 3,840 nodes", async () => {
    const results = await vectorSearch(AXIS_BASELINE, 10, TEACHER_FILTER);
    const found = results.filter((r) => TARGET_IDS.includes(r.id)).length;
    console.error(`[dive:P1] recall@10 = ${found}/10 (results=${results.length})`);
    expect(found).toBe(10);
    for (const r of results) expect(r.tenant_user_id).toBe(TEACHER);
  }, 60_000);

  test("Part 2 — cross-tenant crowding of the over-fetch window degrades recall@10", async () => {
    const rng = mulberry32(7);
    const now = Date.now();
    const curve: Array<{ crowd: number; recallAt10: number }> = [];

    // Probe before any crowd, then add other-tenant thoughts CLOSER to the
    // query axis (sim 0.95 > teacher's 0.80) in increments and re-probe.
    const increments = [0, 200, 100, 150, 300, 450]; // cumulative: 0,200,300,450,750,1200
    let cumulative = 0;
    for (const inc of increments) {
      if (inc > 0) {
        const crowdRows: ThoughtRow[] = [];
        for (let i = 0; i < inc; i++) {
          crowdRows.push({
            id: crypto.randomUUID(),
            content: `Other student's very similar note ${cumulative + i} on the shared class topic`,
            created_at: now,
            tenant: TENANTS[(cumulative + i) % TENANTS.length],
            embedding: nearAxis(AXIS_CROWDED, 0.95, rng),
          });
        }
        await seedThoughts(crowdRows);
        cumulative += inc;
      }
      const results = await vectorSearch(AXIS_CROWDED, 10, TEACHER_FILTER);
      const found = results.filter((r) => CROWD_TARGET_IDS.includes(r.id)).length;
      curve.push({ crowd: cumulative, recallAt10: found });
      console.error(`[dive:P2] crowd=${cumulative} → teacher recall@10 = ${found}/10`);
    }

    // Baseline (no crowd) must be perfect …
    expect(curve[0].recallAt10).toBe(10);
    // … and this test DOCUMENTS the degradation curve. The final point is
    // past the hard over-fetch ceiling (k=10 → window 256; max 1000): if
    // recall@10 is still 10/10 at crowd=1200 the "box" concern is REFUTED;
    // if it collapses, it is CONFIRMED with the exact cliff location.
    const final = curve[curve.length - 1];
    console.error(`[dive:P2] DEGRADATION CURVE: ${JSON.stringify(curve)}`);
    // No hard assert on the final value — the curve itself is the evidence.
    expect(final.crowd).toBe(1200);
  }, 120_000);

  test("Part 3 — positive isolation: 6 sampled tenants see only their own content", async () => {
    for (const tenant of [TENANTS[0], TENANTS[7], TENANTS[13], TENANTS[19], TENANTS[26], TEACHER]) {
      const filter: TenantFilter = { callerUserId: tenant };
      const results = await vectorSearch(AXIS_CROWDED, 10, filter);
      for (const r of results) {
        expect(r.tenant_user_id).toBe(tenant);
      }
    }
  }, 60_000);

  test("Part 4 — consolidation-worker write storm does not corrupt recall correctness", async () => {
    const g = getGraph();
    const now = Date.now();

    // Seed 60 unprocessed Episodes for a background tenant (benign records).
    const episodeIds: string[] = [];
    for (let i = 0; i < 60; i++) {
      const id = await createNode(
        "Episode",
        {
          content: `Class recap ${i}: students worked on ${TOPICS[i % TOPICS.length]}`,
          source_type: "voice",
          participants: [],
          timestamp: now,
          event_at: now,
          processed: false,
        },
        { userId: TENANTS[i % TENANTS.length] },
      );
      episodeIds.push(id);
    }

    // The writer replicates process-queue.ts's per-episode write pattern
    // (findEntityByName → createNode Entity → involves edge → SET processed)
    // with canned extraction output — a HARSHER storm than production
    // because there is no LLM latency between write transactions.
    let writes = 0;
    const writer = (async () => {
      for (let i = 0; i < episodeIds.length; i++) {
        const tenant: TenantStamp = { userId: TENANTS[i % TENANTS.length] };
        const filter: TenantFilter = { callerUserId: tenant.userId };
        const entityName = `Topic ${i % 12}`;
        const existing = await findEntityByName(entityName, filter);
        const entityId =
          existing?.id ??
          (await createNode(
            "Entity",
            {
              name: entityName,
              type: "concept",
              summary: `Classroom topic ${i % 12}`,
              synonyms: [],
              created_at: now,
              updated_at: now,
            },
            tenant,
          ));
        await createEdge("Episode", episodeIds[i], "Entity", entityId, "involves", {
          source_episode_id: episodeIds[i],
        });
        await g.query(`MATCH (ep:Episode {id: $id}) SET ep.processed = true`, {
          params: { id: episodeIds[i] },
        });
        writes += 3;
      }
    })();

    // Concurrent reader: 40 correctness probes while the storm runs.
    const latencies: number[] = [];
    let wrongNeighborProbes = 0;
    for (let p = 0; p < 40; p++) {
      const t0 = performance.now();
      const results = await vectorSearch(AXIS_BASELINE, 10, TEACHER_FILTER);
      latencies.push(performance.now() - t0);
      const found = results.filter((r) => TARGET_IDS.includes(r.id)).length;
      if (found !== 10) wrongNeighborProbes++;
    }
    await writer;

    // Quiet baseline for latency comparison.
    const quiet: number[] = [];
    for (let p = 0; p < 40; p++) {
      const t0 = performance.now();
      await vectorSearch(AXIS_BASELINE, 10, TEACHER_FILTER);
      quiet.push(performance.now() - t0);
    }

    console.error(
      `[dive:P4] writes=${writes} | contended p50=${pct(latencies, 50).toFixed(1)}ms ` +
        `p95=${pct(latencies, 95).toFixed(1)}ms | quiet p50=${pct(quiet, 50).toFixed(1)}ms ` +
        `p95=${pct(quiet, 95).toFixed(1)}ms | wrong-neighbor probes=${wrongNeighborProbes}/40`,
    );
    expect(wrongNeighborProbes).toBe(0);
  }, 180_000);

  test("Part 5 — unbounded substring strategy: ranking indeterminacy + latency under flood", async () => {
    // 400 teacher-owned thoughts all containing the word "empathy" (benign
    // filler), so graphSearch (recall.ts — CONTAINS, no LIMIT) matches 400+.
    const rng = mulberry32(99);
    const now = Date.now();
    const rows: ThoughtRow[] = [];
    for (let i = 0; i < 400; i++) {
      rows.push({
        id: crypto.randomUUID(),
        content: `Filler ${i}: the class discussed empathy in passing during ${TOPICS[i % TOPICS.length]}`,
        created_at: now - i * 30_000,
        tenant: TEACHER,
        embedding: randUnit(rng),
      });
    }
    await seedThoughts(rows);

    const t0 = performance.now();
    const res = await recall("empathy", TEACHER_FILTER);
    const ms = performance.now() - t0;

    // The 10 baseline TARGETS also contain "empathy" and are the truly
    // relevant items. With a flat 0.7 substring score and no lexical
    // ranking, whether they surface is arbitrary — measure it.
    const targetsInTop10 = res.results.filter((r) => TARGET_IDS.includes(r.id)).length;
    console.error(
      `[dive:P5] recall('empathy') latency=${ms.toFixed(0)}ms | strategies=${res.strategies_used} ` +
        `| true targets in top-10 = ${targetsInTop10}/10 (410 substring matches, flat 0.7 score)`,
    );
    expect(res.results.length).toBeGreaterThan(0);
  }, 120_000);
});
