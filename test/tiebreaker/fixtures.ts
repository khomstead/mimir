/**
 * Mimir box tiebreaker test — deterministic fixtures.
 *
 * Synthetic vector geometry with KNOWN ground-truth neighborhoods:
 * 30 clusters, each anchored to an exactly-orthogonal basis axis of the
 * 1024-dim embedding space. Cluster members sit at cosine ~0.86–0.965 to
 * their axis; cross-cluster similarity is ~0 (noise-level). Members of a
 * cluster are therefore mutual nearest neighbors BY CONSTRUCTION, and the
 * exact top-k for any probe is computable by brute-force cosine in
 * float64 — the ground truth the approximate index is judged against.
 *
 * Determinism: mulberry32 PRNG with fixed seeds; node ids are structured
 * strings (`tb-c07-m012-p1`), not UUIDs, so fixture dumps diff cleanly
 * across runs.
 */

export const DIM = 1024;
export const NUM_CLUSTERS = 30;

/** mulberry32 — deterministic PRNG so runs are reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function normalize(v: number[]): number[] {
  let s = 0;
  for (const x of v) s += x * x;
  const n = Math.sqrt(s) || 1;
  return v.map((x) => x / n);
}

/** Random unit vector (cos ~0 to any fixed axis, |cos| ≲ 0.1 whp). */
export function randUnit(rng: () => number): number[] {
  const v = new Array(DIM);
  for (let i = 0; i < DIM; i++) v[i] = rng() * 2 - 1;
  return normalize(v);
}

/** Unit vector at approximately `sim` cosine similarity to `axis`. */
export function nearAxis(axis: number[], sim: number, rng: () => number): number[] {
  const noise = randUnit(rng);
  const proj = noise.reduce((s, y, j) => s + y * axis[j], 0);
  const ortho = normalize(noise.map((x, i) => x - axis[i] * proj));
  const b = Math.sqrt(1 - sim * sim);
  return normalize(axis.map((x, i) => sim * x + b * ortho[i]));
}

/** Exactly-orthogonal basis axis e_idx. */
export function basisAxis(idx: number): number[] {
  const v = new Array(DIM).fill(0);
  v[idx] = 1;
  return v;
}

export function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < DIM; i++) s += a[i] * b[i];
  return s;
}

export interface ThoughtRow {
  id: string;
  content: string;
  created_at: number;
  tenant: string;
  embedding: number[];
}

/**
 * Designed target sims: 5 per cluster, ~0.015 apart — ≥5σ vs the ~0.003
 * cross-noise a 0.985-sim probe sees, so target ORDER is stable. All
 * background members sit at ≤0.855, leaving a structural ~0.03 (#5→#6)
 * gap. The margin guard in bruteForceTopK verifies both deterministically.
 */
export const TARGET_SIMS = [0.945, 0.93, 0.915, 0.9, 0.885] as const;

/**
 * Build one phase's worth of cluster members + filler for a tenant.
 * When `targetsPerCluster` > 0 (first phase only), the first members of
 * each cluster are the designed TARGETS at TARGET_SIMS; all remaining
 * members are background at sim ∈ [0.70, 0.855]. Filler thoughts point in
 * random directions (|cos| ≲ 0.1 to any probe — never near a top-5).
 */
export function buildPhaseRows(opts: {
  phase: string;
  tenant: string;
  membersPerCluster: number;
  memberOffset: number; // continue member numbering across phases
  targetsPerCluster?: number;
  filler: number;
  rng: () => number;
  now: number;
}): ThoughtRow[] {
  const rows: ThoughtRow[] = [];
  const targets = opts.targetsPerCluster ?? 0;
  for (let c = 0; c < NUM_CLUSTERS; c++) {
    const axis = basisAxis(c);
    for (let m = 0; m < opts.membersPerCluster; m++) {
      const mm = opts.memberOffset + m;
      const isTarget = m < targets;
      const sim = isTarget
        ? TARGET_SIMS[m]
        : 0.70 + opts.rng() * 0.155; // background: [0.70, 0.855)
      const id = `tb-c${String(c).padStart(2, "0")}-m${String(mm).padStart(3, "0")}-${opts.phase}${isTarget ? "-T" : ""}`;
      rows.push({
        id,
        content: `probe-token-cluster-${String(c).padStart(2, "0")} member-${mm} ${opts.phase} synthetic classroom note about topic ${c}`,
        created_at: opts.now - mm * 1000 - c,
        tenant: opts.tenant,
        embedding: nearAxis(axis, sim, opts.rng),
      });
    }
  }
  for (let f = 0; f < opts.filler; f++) {
    rows.push({
      id: `tb-filler-${opts.phase}-${String(f).padStart(3, "0")}`,
      content: `filler ${opts.phase}-${f} unrelated synthetic background noise`,
      created_at: opts.now - 10_000_000 - f,
      tenant: opts.tenant,
      embedding: randUnit(opts.rng),
    });
  }
  return rows;
}

export interface GroundTruthEntry {
  cluster: number;
  expected: Array<{ id: string; sim: number }>;
  /** similarity gap between expected #k and the first excluded candidate */
  margin: number;
}

/**
 * Exact brute-force top-k over `rows` for `probe` (cosine similarity,
 * descending). Throws if the #k → #k+1 similarity margin is below
 * `minMargin` — a degenerate fixture whose expected set could flip on
 * float32 rounding must fail loudly, not assert flakily.
 */
export function bruteForceTopK(
  probe: number[],
  rows: ThoughtRow[],
  k: number,
  minMargin = 1e-3,
): { expected: Array<{ id: string; sim: number }>; margin: number } {
  const scored = rows
    .map((r) => ({ id: r.id, sim: dot(probe, r.embedding) }))
    .sort((a, b) => b.sim - a.sim);
  if (scored.length < k + 1) {
    throw new Error(`bruteForceTopK: need at least ${k + 1} rows, got ${scored.length}`);
  }
  const margin = scored[k - 1].sim - scored[k].sim;
  const top1Margin = scored[0].sim - scored[1].sim;
  if (margin < minMargin || top1Margin < minMargin) {
    throw new Error(
      `bruteForceTopK: degenerate fixture — #${k}→#${k + 1} margin ${margin.toExponential(2)} ` +
        `(${scored[k - 1].id} vs ${scored[k].id}), #1→#2 margin ${top1Margin.toExponential(2)} ` +
        `(${scored[0].id} vs ${scored[1].id}); minimum ${minMargin}. ` +
        `Reseed with a different jitter before trusting assertions.`,
    );
  }
  return { expected: scored.slice(0, k), margin };
}

export function pct(xs: number[], p: number): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

export function fmtMs(xs: number[]): string {
  return `p50=${pct(xs, 50).toFixed(1)}ms p95=${pct(xs, 95).toFixed(1)}ms n=${xs.length}`;
}
