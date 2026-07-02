# Mimir Deep Dive — Findings (fable-mimir-dive)

> Fable 5, 2026-07-01. Evaluated against the three roles in
> `gobot/docs/fable5-review/17-use-case-anchor.md` (EA / faculty↔student
> trajectory / bounded student thought-partner) — never in the abstract.
> Every verdict is backed by a run test in this worktree or a code line.
> **Live personal-brain graph untouched**: every harness uses an isolated
> `/tmp` falkordblite instance (grep-verifiable — no test references the
> live path or port :4200); all temp instances torn down after the run.
> The live `dump.rdb` mtime advanced during the dive because the
> production daemon saves its own RDB continuously — no dive process ever
> referenced that path.

**Test evidence in this branch** (all green, isolated instances):
- `src/__tests__/scale-correctness.dive.test.ts` — Q2 (5 tests)
- `src/__tests__/proactive-connection.dive.test.ts` — Q3 + multimodal (5 tests)
- `src/__tests__/tenant-gate.dive.test.ts` — Q5, real service subprocess (5 tests)
- Full suite: **85 pass / 0 fail** (`BRAIN_DISABLE_LLM=true bun test`, 16.3s)

---

## Environment baseline (a finding in itself)

`bun test` initially ran **68 pass / 2 fail** — both failures were stale
1536-dim stub vectors written against the 1024-dim vector index left over
from the Qwen3 embedding migration. One of the two was **FAIL-CLOSED
tenant contract A** (`tenant-isolation.test.ts:96`): **the security
contract suite had not run green since the embedding migration** — the
guard existed but was not gating anything. Six test files carried the
stale dimension. Fixed in `0702b41`; the suite must be wired into a
pre-ship gate or it will rot again.

Also: `src/index.ts` (the MCP stdio entry point) still calls
`retain()` with no tenant stamp and `recall(query, scope, …)` against the
Phase-1E `recall(query, filter, …)` signature (index.ts:68, :120) — it is
a stale pre-1E entry point that throws at runtime. The real MCP path is
`proxy.ts` → HTTP. Dead code on a security-sensitive seam; delete or fix.

---

## Q1 — Is the substrate still best-in-class for these three demands?

**Verdict: KEEP the substrate; the gaps are all in layers above it.**
Full survey (with URLs for every claim) ran against the 2026 field: Mem0
(arXiv 2504.19413), Zep/Graphiti (arXiv 2501.13956), Letta sleep-time
compute, Cognee, Hindsight (arXiv 2512.12818), A-MEM (NeurIPS 2025),
Microsoft LazyGraphRAG/BenchmarkQED, HippoRAG 2, GraphRAG-Bench (ICLR
2026, arXiv 2506.05690), BKT/DKT learner models, SMILI open learner
models, Teaching Strategies GOLD, ChatGPT Pulse, Limitless.

What the field independently converged on — and Mimir already does:
Episode-as-immutable-ground-truth with derived layers (Zep, Hindsight,
event-sourcing consensus); soft invalidation over deletion (Graphiti,
Mem0); fact-bearing edges with temporal validity + episode provenance
(Graphiti's core innovation — its +38% temporal-reasoning wins are the
evidence the pattern pays); multi-strategy recall (GraphRAG-Bench's
negative result — graphs only help relational questions — vindicates
parallel strategies over graph-only); **local small models are not a
compromise** (Hindsight beats full-context frontier models on LongMemEval
with an open 20B backbone). The **Anchor node type is genuinely novel** —
nothing surveyed has a first-class tension-checked constraint layer, and
for role 3 (minors) an explicit constraint layer with provenance is what
the 2026 regulatory climate (GUARD Act, COPPA amendments) demands. The
all-local extraction/embedding posture is a differentiator no cloud
memory vendor matches (California AB 1159 direction: student data must
not train models).

**Per-component verdicts** (against the three roles):

| Component | Verdict | Why (evidence) |
|---|---|---|
| Embedded falkordblite "box" | **KEEP** | Contention refuted by run test (Q2-P4: zero wrong probes, no latency delta under a harsher-than-prod write storm); field consensus: 1–30 users on one Mac is defensible |
| 4-node bi-temporal model (Episode/Thought/Entity/Anchor) | **KEEP** | Matches Zep/Hindsight/event-sourcing consensus; add transaction-time (`created_at/expired_at`) later for audit-grade "what did we believe on date X" |
| Fact edges (valid_from/until + provenance lists) | **KEEP** + one port | Graphiti-validated; highest-leverage remaining port: run contradiction detection on every ingest against fact edges, not only Anchors |
| `vectorSearch` tenant post-filter | **REFACTOR before September** | Q2 crowding cliff (below) — the one live correctness defect |
| `recall()` verb | **KEEP core / refactor ranking** | Semantic strategy is strong (Q3-A: zero-word-overlap paraphrase → right answer, rank 0). But substring strategy is unbounded with a flat 0.7 score — no lexical ranking (Q2-P5: true targets 0/10 under flood). Add a LIMIT + BM25-ish scoring |
| `/api/context` (every-turn EA path) | **REFACTOR (cheap, high value)** | It never calls the semantic strategy — substring on the first 3 words only (service.ts:506-522). Run-verified at HTTP layer (Q5): concept paraphrase misses, literal word hits. This — not `recall()` — is where the production "Light Cycle" failure lives. Route it through `recall()` |
| Anchor search | **REFACTOR** | Literal substring confirmed by code (recall.ts:340) and by run test (Q3-B). Anchors need embeddings (the existing "anchor overhaul" card is right) |
| Extraction (local gemma, ADD/UPDATE/INVALIDATE) | **KEEP + validate** | Field-standard intent pipeline; local is fine (Hindsight evidence). Quality on gemma-26b vs Haiku remains unvalidated — needs a small eval harness, not a redesign |
| Entity dedup | Known-deferred (Phase 1G) | Field answer unchanged: Graphiti MinHash/LSH; per-org dedup at Lighthouse scale |
| Proactive layer | **NET-NEW above substrate** | Field has three mechanisms Mimir lacks: write-time link generation (A-MEM), idle-time consolidation (Letta sleep-time), scheduled digest (Pulse). Dive 2 territory — the substrate doesn't block it |
| MCP stdio entry (`src/index.ts`) | **DELETE/fix** | Stale pre-1E signatures; throws at runtime |

What nobody in the field has solved (Mimir is not behind): narrative-
evidence learner modeling (KT needs item responses; memory vendors don't
model competence — role 2 is genuine white space); validated "surprising
but true" proactive surfacing; regulatory-grade memory for minors.

---

## Q2 — Does recall stay CORRECT at classroom scale?

**Verdict: FAIL as-shipped — confirmed with exact mechanism and numbers;
resolves the synthesis's Medium-confidence "box" call to: KEEP the
embedded graph, REFACTOR the vector-search path. The box is fine; the
un-pre-filtered ANN call inside it is the defect.**

**Harness:** `scale-correctness.dive.test.ts` — 3,740 synthetic thoughts
across 31 tenants (30 students + 1 teacher), deterministic seeded
vectors, isolated `/tmp` instance. Run 2026-07-01, 5 pass, 12.3s.

| Part | Result |
|---|---|
| P1 right-neighbors baseline, 3,840 nodes | recall@10 = **10/10** |
| P2 cross-tenant crowding of the over-fetch window | crowd 0 → 10/10 · 200 → 10/10 · **300 → 0/10** · 450/750/1200 → 0/10 |
| P3 positive isolation, 6 sampled tenants | only own-tenant results on every probe |
| P4 consolidation contention (180 writes, worker's exact write pattern, no LLM pauses between transactions = harsher than prod) | **0/40 wrong-neighbor probes**; contended p50 3.7ms / p95 4.6ms vs quiet p50 3.7ms / p95 3.9ms |
| P5 unbounded substring flood (410 matches) | 23ms latency (fine) but true targets **0/10** in top-10 — flat 0.7 score is unranked |

**Mechanism** (corrected per 11-corrections C4 — there is no literal
"1000-node cap"): `vectorSearch` over-fetches
`min(max(k*20, 256), 1000)` candidates from the approximate index, then
post-filters by tenant (graph.ts:583-649). For the k=10 recall path the
window is **256**. Once ≥256 other-tenant vectors sit closer to the query
than the caller's own relevant content, the caller's content falls past
the window and recall silently returns **zero** of it — a cliff, not a
slope. At Lighthouse scale this is the *normal* regime: 30 students
writing near-duplicate notes on the same class topics guarantees dense
shared vector neighborhoods. The 1000 hard ceiling means no k fixes it.
Wrong/empty neighbors at scale = the EA resurfaces nothing or the wrong
thing = the trust-death the anchor doc names.

**What is NOT broken:** consolidation contention (the synthesis's other
worry) — refuted at this scale. Embedded falkordblite serialized the
storm with no correctness loss and no measurable latency delta.

**Recommendation** (one decision for Kyle, not a rebuild): make vector
retrieval tenant-aware before September. Options, cheapest-honest first:
1. **Per-tenant graphs** — `db.selectGraph("mimir_<userId>")`; the
   federated model `initGraph`'s own comment anticipates. Crowding
   disappears structurally; tenant isolation becomes physical. Cost:
   folio-shared reads become a fan-out across sharer graphs; org-canon
   needs a shared graph. Also pre-solves the Phase-1G dedup shape.
2. **Paged ANN retry** — keep fetching candidate pages until k
   same-tenant hits found. Minimal change; latency grows with crowding
   but correctness is restored.
3. External vector store with native filtered ANN (heavier; only if 1/2
   prove insufficient).

---

## Q3 — Proactive, or merely literal?

**Verdict: the substrate is semantically capable; the surfaces are
literal. Two cheap refactors close most of the gap; true proactivity
(2-hop, unprompted) is absent and is Dive-2 net-new.**

Run evidence (`proactive-connection.dive.test.ts`, real production
embedder — local oMLX Qwen3):

- **Semantic recall works.** "which student struggles with public
  speaking" (zero content-word overlap) → the Marcus freezes-when-
  reading-aloud thought at **rank 0, via the semantic strategy**
  (score 0.634). The "Light Cycle"-class concept query ("competency
  based assessment system") also hits at **rank 0** through `recall()`.
- **But the EA's every-turn path never uses it.** `/api/context` is
  substring-only (service.ts:506-522). HTTP-verified in the Q5 harness:
  concept paraphrase → miss; literal word → hit. The brief's production
  concept-recall failure is real but **mislocated** — it is not a recall
  defect, it is `/api/context` never calling the semantic strategy.
- **Anchor search is literal substring** — confirmed in code
  (recall.ts:340 `CONTAINS`) and by run: paraphrase ("dropped follow-ups
  and forgotten promises") misses the "Nothing falls through the cracks"
  anchor; the literal word "cracks" finds it.
- **No 2-hop surfacing exists anywhere.** Marcus→Empathy Goal→Peer
  Mediation wired via `connect()`; `pulse("Marcus")` returns only the
  1-hop neighbor (pulse.ts:156-167 is single-hop; recall's graphSearch
  only decorates matched Thoughts with their direct entity names,
  recall.ts:197). The "two people who fit the grant you're drafting"
  EA moment has no mechanism today.

**Recommendation:** (1) route `/api/context` through `recall()` —
single-file change, transforms the EA's daily experience; (2) embed
anchors; (3) treat multi-hop + unprompted surfacing as the Dive-2
proactive layer (field patterns: A-MEM write-time linking, Letta
sleep-time consolidation) — the graph substrate supports it; nothing
needs rebuilding to add it.

---

## Q4 — Can it represent + aggregate narrative evidence into a non-monotonic, person-scoped, multi-year trajectory?

**Verdict: NOT today — and the honest call is a HYBRID: wire the
evidence layer inside Mimir (small addition), build the goal/OLM domain
layer beside it (net-new, as synthesis already planned). This is NOT a
rebuild of Mimir — no Kyle-decision fork on the substrate; Dive 2 can
proceed on "substrate stands" (branch A).**

Grounding (code, this worktree + gobot read-only):

- `progresses_from` / `demonstrates` / `contributes_to` exist in the
  EdgeType union (types.ts:255-262), the extraction prompt
  (extraction.ts:72 — *relationships only*; the facts[] prompt at
  extraction.ts:78 excludes them, so they can never arrive as
  fact-bearing edges), and the connect enums (index.ts:207,
  proxy.ts:327). **No Cypher read path anywhere queries them** —
  grep-verified: the only hits are enum/prompt definitions. Latent, as
  the anchor doc said.
- No Goal/Competency node type exists. Worse for trajectories: **the
  Entity UPDATE-merge actively destroys longitudinal shape** — the
  Mem0-pattern LLM merge (graph.ts:729-754, retain.ts:164-166) collapses
  history into one evolving summary blob. A student's "one step forward,
  two back" becomes a single overwritten paragraph. The substrate's own
  evolution primitive is anti-trajectory for this use case.
- Convex side (brief 06, confirmed by grep): `charter_goals` is
  folio-scoped with no userId; `setGoalStatus` patches destructively; no
  progress-events table (`kAnonymity.ts` names `lighthouse_progress_
  events` — the table does not exist); alignment scores are computed and
  discarded.
- What Mimir already has that the trajectory needs: bi-temporal Episodes
  (`event_at` ≠ ingest verified by run test Q3-D), provenance links,
  tenant scoping, voice ingestion, `as_of` time-slice queries.

**The specific structures each half needs:**

*Inside Mimir (wire-latent — small, verb-sized):*
1. A `Goal` node type (person-scoped: `tenant_user_id` = the student,
   with `template_id?` for shared competencies vs bespoke).
2. `demonstrates` edges Episode→Goal carrying `{direction: +1|0|-1,
   strength, observer_id, event_at}` — the append-only observation
   stream, riding the existing fact-edge machinery (provenance lists,
   validity windows already exist).
3. One new read path: `trajectory(goalId, timeRange)` returning the
   time-ordered evidence stream with per-window net direction —
   aggregation at query time, never stored (brief 06's rule, correct).
4. Exempt Goal nodes from UPDATE-merge (goals evolve by *events*, not by
   summary rewrite).

*Beside Mimir (net-new, Convex/Observatory — as synthesis Phase 4
already carries at High confidence):* goal templates/instances
(competency framework), the k-anonymized cohort aggregation, and the
"exquisite UI that visualizes the arc" — an Open Learner Model surface
(SMILI-style inspectable/contestable, which the Constitution
independently demands via #1/#3/#5). The field survey found this exact
combination — psychometric trajectory + narrative/photo evidence — is
solved by nobody; Teaching Strategies GOLD is the deployed workflow to
emulate, with human judgment in the promote-to-visible gate.

---

## Q5 — Do the September foundations hold?

**Verdict: tenancy PASS (fail-closed verified end-to-end at the HTTP
boundary, and — grounding correction — already enforced in production);
the consent/classification gate DOES NOT EXIST but what's needed is
light: record-class tagging + purpose limitation at one chokepoint, plus
policy acts that are Kyle's, not code.**

Framed and tested as privacy / multi-tenant data-isolation /
authorization-boundary engineering with synthetic benign records and
positive isolation assertions (`tenant-gate.dive.test.ts`, real
`service.ts` subprocess on throwaway ports + /tmp data, 5 pass):

- **Enforced posture** (`MIMIR_REQUIRE_TENANT_HEADER=true`, no
  fallback): missing `X-Mimir-User-Id` → **401 on both read and write**;
  teacher_a's record visible to teacher_a, invisible to student_b;
  Bearer gate rejects missing/wrong tokens; /health stays open. The
  graph layer additionally holds positive isolation across 30 tenants at
  3,740 nodes (Q2-P3) and all six FAIL-CLOSED contracts pass (baseline
  suite, after the stale-dimension fix).
- **Grounding correction to the briefs:** the production launchd plist
  already sets `MIMIR_REQUIRE_TENANT_HEADER=true` — the plist's own
  comment ("false until gobot ships") is stale. The service-side flip
  the synthesis scheduled as Phase-0 work is **already done**.
- **The remaining leak surface is exactly where the census said:** the
  MCP proxy's `resolveCallerUserId()` (proxy.ts:56-60) falls back
  `MOSSCAP_ACTOR_USER_ID → MIMIR_USER_ID → GOBOT_DEFAULT_USER_ID` and
  sends a *present-but-wrong* header that the service gate rightly
  accepts. Demonstrated as run evidence in the cutover-mode service: an
  unattributed write landed in the default user's tenant (mis-stamp, not
  401). September work = census steps 1–4 (make gobot's spawn helpers
  token-capable, fail the turn on mint failure, remove the proxy
  fallback) — all in gobot, none in Mimir.
- **Consent/classification gate at retain():** grep-verified absent (no
  `recordClass`/consent anywhere in the retain path;
  `MIMIR_FAST_RETAIN` is unset in prod, so extraction is inline and the
  30s worker is a backstop, not an auto-distiller — consistent with
  correction C3). Per correction C7 (Alma "school official" model), the
  gate that's actually needed: `record_class` tagging on every Episode
  at retain (educational_record / behavioral_observation /
  personal_note), purpose-limitation metadata, retention/TTL policy for
  minors (2026 COPPA minimization), and school-directed deletion — the
  deletion primitives (`forget`, `forget-cascade`, audit trail)
  **already exist and are tested**. No per-record consent capture. The
  blocking prerequisite is contractual (org designates Observatory a
  school official), which is Kyle's layer.
- **Process finding:** the tenant-isolation suite was silently broken
  (stale dims) — a fail-closed *suite* that isn't run is an open gate.
  Wire `bun test` into the ship path.

---

## Multimodal front door (through-line requirement)

**Voice: PASS, first-class.** Run-verified (Q3-D): `retain(source:
"voice", event_at: yesterday)` produces an Episode with
`source_type='voice'`, event time ≠ ingest time (bi-temporal holds), and
voice carries the *highest* source authority (0.9, graph.ts:37) —
exactly right for a voice-first product.

**Images/artifacts: ABSENT.** The entire API surface accepts only
`body.content` text (service.ts:313-333); no bytes/URI/attachment field
exists; `Artifact` appears once, as a comment example of a non-tenant
label (graph.ts:357). The field pattern to adopt (Limitless, Cognee):
keep the artifact addressable (file/URI on the Artifact node), derive a
VLM description as the searchable Thought, link both to the Episode for
provenance. This is an add-a-node-type + one-endpoint change on the
Mimir side; the real work (who runs the VLM — frontier or local) is the
model-agnostic seam, as the anchor doc anticipated.

---

## The overall picture

**Keep the substrate. Refactor the retrieval surfaces. Build the
trajectory and proactive layers on top. Nothing here is a rebuild.**

- **KEEP:** embedded falkordblite box (contention refuted by test),
  4-node bi-temporal model, fact-edge machinery, tenant predicate layer
  (all six contracts green), local-model posture, Anchor concept.
- **REFACTOR (September-critical):** ① tenant-aware vector retrieval
  (the Q2 cliff — the one live correctness defect); ② `/api/context` →
  route through `recall()` (the EA make-or-break, one file); ③ proxy
  fallback removal (census steps, gobot-side); ④ anchor embeddings.
- **NET-NEW (the mission, on a sound base):** Goal node + demonstrates
  observation stream + `trajectory()` read path inside Mimir; goal
  templates + OLM arc UI + k-anon aggregation beside it; consent
  record-class gate at retain; Artifact/image ingestion; the proactive
  (sleep-time/write-time-linking) layer — Dive 2.

**Q4 rebuild-fork flag for Kyle: NOT RAISED.** The trajectory verdict is
hybrid wire-latent + net-new-beside — the same shape synthesis Phase 4
already carries at High confidence. Dive 2 should proceed on branch A
(substrate stands). The one genuine choice to put in front of Kyle is
**how to fix the Q2 cliff**: per-tenant graphs (structural, also
pre-solves org dedup, complicates folio sharing) vs paged-ANN retry
(minimal, keeps one graph). Both are refactors; they imply different
Phase-1G shapes.

**Top 3 risks:**
1. **The crowding cliff** — as org content grows, per-user recall
   silently drops to zero relevant results (200→300 crowd flipped 10/10
   to 0/10 in test). Trust death for EA and teacher roles; invisible to
   latency monitoring.
2. **The proxy mis-stamp seam** — any gobot spawn path that fails to
   thread the per-user id writes that user's (soon: a minor's) data into
   Kyle's tenant, and the presence-only gate waves it through.
   Compounded by the process finding that the security suite was
   silently broken for weeks.
3. **UPDATE-merge vs the mission** — the entity-evolution primitive
   overwrites longitudinal shape, and extraction quality on local gemma
   is unvalidated; both directly gate the trajectory deliverable that
   is the product's crown jewel.

**How a human confirms each verdict (one line each):**
- Q1: read the survey section's cited URLs; spot-check Graphiti/Hindsight papers against Mimir's graph.ts patterns.
- Q2: `BRAIN_DISABLE_LLM=true bun test src/__tests__/scale-correctness.dive.test.ts` — watch the P2 curve print 10/10 → 0/10 at crowd 300.
- Q3: `BRAIN_DISABLE_LLM=true bun test src/__tests__/proactive-connection.dive.test.ts` — paraphrase hits via semantic; anchor misses paraphrase; pulse shows no 2-hop.
- Q4: `grep -rn "demonstrates\|progresses_from" src/ | grep -v enum` — no read path; and read graph.ts:729 (UPDATE-merge) asking "where did last month go?"
- Q5: `bun test src/__tests__/tenant-gate.dive.test.ts` — 401s without user id, isolation positive, cutover mis-stamp demonstrated; then `grep -A1 REQUIRE_TENANT ~/Library/LaunchAgents/com.speki.mimir.plist`.
