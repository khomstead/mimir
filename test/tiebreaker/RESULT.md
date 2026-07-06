# Mimir box tiebreaker — verdict

**Date:** 2026-07-06 · **Branch:** `tiebreaker-test` · **Harness:** `test/tiebreaker/`
**Provenance:** Fable 5 architecture review, brief-01 gap. Synthesis correction #3
(gobot `docs/fable5-review/10-synthesis.md`): *"the Mimir tiebreaker test can't see its own
bug"* — a latency/queue-depth load test passes on a quiet Mac while (a) the consolidation
worker colliding with live recall and (b) recall correctness past the 1000-node over-fetch
window go unmeasured. This harness measures exactly those two things, against exact
brute-force ground truth.

**Re-run:** `bun test test/tiebreaker/tiebreaker.test.ts` (from the mimir repo root).
Fully isolated: in-process falkordblite instance under `/tmp/zztest-tiebreaker-*`; never
touches the live service (`com.speki.mimir`, localhost:4200) or
`/Volumes/AI-Lab/falkordb-data/personal-brain`. Deterministic (mulberry32 seeds; ground
truth verified byte-identical across two consecutive runs). Deletes its instance at the
end and asserts the deletion. Run evidence in `test/tiebreaker/out/`
(`ground-truth.json`, `metrics.json`).

## 1. Correctness at 500 / 1000 / 1530 nodes — PASS at every size

30 clusters of mutual-nearest-neighbor synthetic vectors (orthogonal 1024-dim axes), one
caller tenant, 5 designed ground-truth targets per cluster; expected top-5 computed by
exact float64 brute force and margin-guarded (#1→#2 and #5→#6 gaps ≥ 1e-3, so float32
rounding cannot flip an assertion). Per the `feedback_verify_recall_by_content_rank`
discipline, every probe asserts the RIGHT known item ranks **#1** plus exact top-5 set
equality — never "results returned."

| Graph size (caller nodes) | Clusters correct (rank-#1 + top-5) | probe p50 / p95 |
|---|---|---|
| 500  | 30/30 | 1.4ms / 2.1ms |
| 1000 | 30/30 | 1.6ms / 1.9ms |
| 1530 | 30/30 | 1.8ms / 2.3ms |

No size-driven degradation up to 1530 caller nodes (2630 total with decoys): the k=10
initial window of 256 candidates was sufficient for the HNSW index to surface the exact
neighbors in this geometry.

## 2. Over-fetch-window behavior, actually observed

**Where the "1000-node cap" actually lives** (correcting the synthesis's shorthand, per
`11-corrections-from-grounding.md` C4 — there is no literal graph-size cap):

- `src/graph.ts:595` — initial candidate window `fetchK = min(max(k*20, 256), 1000)`;
  1000 is the **first-pass ceiling**, hit whenever k > 50.
- `src/graph.ts:659,664` — candidates are tenant-POST-filtered (FalkorDB's
  `db.idx.vector.queryNodes` cannot pre-filter); return when k survivors found or the
  index is exhausted.
- `src/graph.ts:667` — `fetchK *= 4` escalation (crowding-cliff fix, commit `b2adee6`,
  2026-07-02). Before this commit the window was FIXED — the regime the synthesis warned
  about.
- `src/verbs/recall.ts:112` — the recall verb's semantic strategy calls this with k=10.

**Observed** (1100 other-tenant decoy vectors seeded strictly closer to the probe than
every caller node — the classroom regime, 30 students writing near-duplicates of the
same topic):

- Raw fixed window of 256: **0** caller nodes among candidates. Raw fixed window of
  1000 (the former ceiling): **0** caller nodes. A fixed-window vectorSearch here
  returns zero-to-wrong results **silently and fast** — latency assertions cannot see
  it. This reproduces the pre-2026-07-02 bug shape and confirms the synthesis's concern
  was real.
- The current escalating implementation returned the exact correct top-5 at every
  crowded probe (15/15), at **p50 17.0ms vs 1.7ms uncrowded (~10×)** — correctness was
  bought with latency. The escalation's final round approaches a full index sweep, so
  this cost grows roughly linearly with crowd size: at school scale (10–100× nodes) a
  crowded probe becomes a hundreds-of-ms-to-seconds query, i.e. the failure mode is now
  a latency cliff rather than silent wrongness. That is the correct direction (loud,
  measurable) but not a scaling answer.

## 3. Consolidation-worker contention — PASS, delta small at this scale

The **real** `processQueue()` (`src/verbs/process-queue.ts`) ran in its production shape
— same process as recall serving, batch 10 (`src/service.ts:725-748`) — but harsher:
back-to-back passes with zero interval and LLM extraction replaced by a deterministic
in-process mock (real graph writes: entity find/create, summary updates, involves +
fact edges, contradiction resolution, processed flags; **no LLM calls**,
`BRAIN_DISABLE_LLM=true` as defense-in-depth). A retain-analog sub-phase additionally
inserted embedded Thoughts inline, mutating the vector index during reads
(`MIMIR_FAST_RETAIN` regime).

| Stream | p50 | p95 |
|---|---|---|
| quiet (pre) | 1.8ms | 2.0ms |
| contended — worker writes | 1.9ms | 2.5ms |
| contended — worker + inline vector writes | 1.9ms | 2.4ms |
| quiet (post, index-integrity re-sweep) | 1.8ms | 2.0ms |

- Worker: 109 passes, **960 episodes processed, 0 failed, 0 worker errors**, 13 queue
  re-arms, 15 inline vector writes.
- Recall probes during contention: **0/120 wrong-neighbor probes** — correctness held
  while the worker wrote. Post-storm re-sweep clean (no index corruption).
- Full `recall()` verb under contention: 6 probes, 0 errors, p50 12.5ms (p95 ~500ms —
  first-call oMLX embedding warm-up; n=6, indicative only).
- Contention delta at this scale: **p95 +0.5ms (~25%)** — the engine's small query
  granularity interleaves worker writes with reads without starving them. Caveats:
  cooperative single-process concurrency (faithful to the production architecture, which
  runs the worker via `setInterval` in the same Bun process as HTTP recall) and a 2.6k-node
  graph; write transactions grow with graph/extraction size.

## 4. Recommendation (feeds refactor-vs-box)

On the two axes this tiebreaker was corrected to measure, the current substrate does
**not** exhibit a box-forcing correctness defect: recall is exactly right at 1530+ nodes,
stays exactly right while the real consolidation worker hammers the same graph, and the
former silent-wrong-neighbors regime past the 1000-candidate ceiling is now rescued by
the escalation loop (commit `b2adee6`) — verified here under crowding AND contention.
What remains is a **priced-in latency liability, not a correctness one**: escalation
degenerates toward a full-index sweep exactly in the classroom regime (many tenants,
same topics), ~10× at 2.6k nodes and growing roughly linearly, because FalkorDB's ANN
cannot pre-filter by tenant. So the evidence resolves the tiebreaker toward **refactor,
not box** — with one non-negotiable rider: per-tenant/filtered ANN (the "Phase-1G-shaped
decision" already flagged at `graph.ts:590`) must land **before** classroom scale, and
this harness re-run with 10×–100× decoy counts is the tripwire — if crowded-probe p95
at projected school scale exceeds the interactive budget (~200ms), the box decision
re-opens. Secondary liabilities the harness surfaced in passing, for the refactor
backlog: the unbounded substring scan in `recall.ts` graphSearch (no LIMIT; full label
scan per recall) and the flat-0.7 substring scoring that leaves ranking to chance under
floods (both already documented by the 2026-07-01 dive, P5).

## Scope limits (honesty)

- Synthetic orthogonal-cluster geometry isolates the retrieval machinery (window,
  escalation, tenant filter, HNSW traversal, engine contention) from embedder quality.
  Real Qwen3 embeddings occupy a narrower cone of the space; the 2026-07-01 dive's
  observation of a wrong top-set at k=40 on the real 3,784-node graph suggests real
  geometry is, if anything, harsher on small windows than this fixture.
- Contention is cooperative (single event loop) — same as production's architecture, but
  it does not model multi-process readers; there are none today.
- `recall()`-verb assertions under contention are error/latency-level; rank-correctness
  is asserted at the `vectorSearch` layer, which is where the window mechanism lives.
