/**
 * Mimir Deep Dive — Q5: September foundations — the tenant gate at the
 * HTTP boundary (privacy / multi-tenant data-isolation / authorization-
 * boundary engineering; COPPA-FERPA compliance posture).
 * (fable-mimir-dive, 2026-07-01)
 *
 * Exercises the REAL service (src/service.ts) as a subprocess on a
 * throwaway port + /tmp data path — never the launchd daemon at :4200,
 * never the live graph. All records are synthetic and benign; all
 * assertions are POSITIVE isolation assertions.
 *
 * Two service configurations:
 *   ENFORCED  (MIMIR_REQUIRE_TENANT_HEADER=true, no default-user fallback)
 *     — the post-cutover fail-closed posture September requires.
 *   CUTOVER   (gate=false, GOBOT_DEFAULT_USER_ID set)
 *     — today's production posture; demonstrates, as run evidence, the
 *       caller-census finding: a missing per-user id is silently stamped
 *       to the default user (mis-attribution, not a 401).
 *
 * Also asserts at the HTTP layer that /api/context (the every-turn
 * prompt-injection path) resolves concept paraphrases via the semantic
 * recall() strategies — the regression gate for the production
 * "Light Cycle" failure class the dive found (it was substring-only on
 * the first ~3 query words until the 2026-07-02 fix routed it through
 * recall()). Requires the local oMLX embedder, same as the other dive
 * suites.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";

const SECRET = "dive-shared-secret";
const ENFORCED_PORT = 4299;
const CUTOVER_PORT = 4298;
const ENFORCED_URL = `http://localhost:${ENFORCED_PORT}`;
const CUTOVER_URL = `http://localhost:${CUTOVER_PORT}`;

let enforcedProc: ReturnType<typeof Bun.spawn> | null = null;
let cutoverProc: ReturnType<typeof Bun.spawn> | null = null;

async function waitHealthy(url: string, timeoutMs = 20_000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`${url}/health`);
      if (r.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`service at ${url} did not become healthy in ${timeoutMs}ms`);
}

function spawnService(port: number, dataPath: string, extraEnv: Record<string, string>) {
  return Bun.spawn(["bun", "run", "src/service.ts"], {
    cwd: import.meta.dir + "/../..",
    env: {
      ...process.env,
      MIMIR_PORT: String(port),
      MIMIR_DATA_PATH: dataPath,
      MIMIR_REQUIRE_AUTH: "true",
      MIMIR_SHARED_SECRET: SECRET,
      BRAIN_DISABLE_LLM: "true",
      MIMIR_FAST_RETAIN: "false",
      MIMIR_CONSOLIDATION_INTERVAL: "600000", // keep the worker quiet during the test
      ...extraEnv,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

const auth = { Authorization: `Bearer ${SECRET}` };
const json = { "Content-Type": "application/json" };

describe("Q5 — tenant gate at the HTTP boundary (isolated service instances)", () => {
  beforeAll(async () => {
    enforcedProc = spawnService(ENFORCED_PORT, `/tmp/mimir-dive-gate-enforced-${Date.now()}`, {
      MIMIR_REQUIRE_TENANT_HEADER: "true",
      GOBOT_DEFAULT_USER_ID: "", // no fallback exists in the enforced posture
    });
    cutoverProc = spawnService(CUTOVER_PORT, `/tmp/mimir-dive-gate-cutover-${Date.now()}`, {
      MIMIR_REQUIRE_TENANT_HEADER: "false",
      GOBOT_DEFAULT_USER_ID: "user_default_kyle",
    });
    await Promise.all([waitHealthy(ENFORCED_URL), waitHealthy(CUTOVER_URL)]);
  }, 60_000);

  afterAll(async () => {
    enforcedProc?.kill();
    cutoverProc?.kill();
  });

  // ── ENFORCED (fail-closed) posture ─────────────────────────

  test("health is open; data endpoints are Bearer-gated", async () => {
    expect((await fetch(`${ENFORCED_URL}/health`)).status).toBe(200);
    expect((await fetch(`${ENFORCED_URL}/api/recall?q=x`)).status).toBe(401);
    expect(
      (await fetch(`${ENFORCED_URL}/api/recall?q=x`, { headers: { Authorization: "Bearer wrong" } })).status,
    ).toBe(401);
  }, 30_000);

  test("ENFORCED: request without X-Mimir-User-Id → 401 fail-closed (read AND write)", async () => {
    const read = await fetch(`${ENFORCED_URL}/api/recall?q=classroom`, { headers: auth });
    expect(read.status).toBe(401);
    const write = await fetch(`${ENFORCED_URL}/api/retain`, {
      method: "POST",
      headers: { ...auth, ...json },
      body: JSON.stringify({ content: "synthetic benign note", source: "chat" }),
    });
    expect(write.status).toBe(401);
  }, 30_000);

  test("ENFORCED: per-user writes land in the right tenant; cross-tenant reads come back empty", async () => {
    // Teacher A retains a benign synthetic record.
    const w = await fetch(`${ENFORCED_URL}/api/retain`, {
      method: "POST",
      headers: { ...auth, ...json, "X-Mimir-User-Id": "teacher_a" },
      body: JSON.stringify({
        content: "Teacher A's class recap: the garden project measured rainfall variance today",
        source: "voice",
      }),
    });
    expect(w.status).toBe(200);

    // Teacher A finds their own record.
    const own = await fetch(`${ENFORCED_URL}/api/recall?q=rainfall%20variance`, {
      headers: { ...auth, "X-Mimir-User-Id": "teacher_a" },
    });
    expect(own.status).toBe(200);
    const ownBody = (await own.json()) as { results: Array<{ content: string }> };
    expect(ownBody.results.some((r) => r.content.includes("rainfall"))).toBe(true);

    // Student B (no folio grant) sees nothing of it.
    const cross = await fetch(`${ENFORCED_URL}/api/recall?q=rainfall%20variance`, {
      headers: { ...auth, "X-Mimir-User-Id": "student_b" },
    });
    expect(cross.status).toBe(200);
    const crossBody = (await cross.json()) as { results: Array<{ content: string }> };
    expect(crossBody.results.some((r) => r.content.includes("rainfall"))).toBe(false);
    console.error(
      `[dive:Q5] enforced isolation: owner sees ${ownBody.results.length} result(s); other tenant sees ${crossBody.results.length} matching 0`,
    );
  }, 60_000);

  test("ENFORCED: /api/context resolves a concept paraphrase via semantic recall (Light Cycle regression gate)", async () => {
    await fetch(`${ENFORCED_URL}/api/retain`, {
      method: "POST",
      headers: { ...auth, ...json, "X-Mimir-User-Id": "teacher_a" },
      body: JSON.stringify({
        content:
          "The Light Cycle framework defines the school's graduation requirements: " +
          "learners advance by demonstrating mastery evidence, not seat time or letter grades.",
        source: "document",
      }),
    });

    // Concept paraphrase — none of these words appear in the stored text.
    // Pre-fix this MISSED (substring on the first ~3 query words only);
    // post-fix it must hit through recall()'s semantic strategy.
    const paraphrase = await fetch(`${ENFORCED_URL}/api/context?q=${encodeURIComponent("competency based assessment")}`, {
      headers: { ...auth, "X-Mimir-User-Id": "teacher_a" },
    });
    const paraphraseText = await paraphrase.text();

    // Literal word from the stored text — must keep working.
    const hit = await fetch(`${ENFORCED_URL}/api/context?q=${encodeURIComponent("graduation framework")}`, {
      headers: { ...auth, "X-Mimir-User-Id": "teacher_a" },
    });
    const hitText = await hit.text();

    // And tenant isolation must survive the reroute: another tenant asking
    // the same paraphrase sees nothing of teacher_a's document.
    const cross = await fetch(`${ENFORCED_URL}/api/context?q=${encodeURIComponent("competency based assessment")}`, {
      headers: { ...auth, "X-Mimir-User-Id": "student_b" },
    });
    const crossText = await cross.text();

    console.error(
      `[dive:Q5] /api/context: paraphrase→${paraphraseText.includes("Light Cycle") ? "found" : "MISSED"}; ` +
        `literal→${hitText.includes("Light Cycle") ? "found" : "MISSED"}; ` +
        `cross-tenant→${crossText.includes("Light Cycle") ? "LEAKED" : "isolated"}`,
    );
    expect(paraphraseText).toContain("Light Cycle"); // semantic path now wired (service.ts Phase 1 → recall())
    expect(hitText).toContain("Light Cycle");        // literal path still works
    expect(crossText).not.toContain("Light Cycle");  // tenant wall holds through recall()
  }, 60_000);

  // ── CUTOVER (today's production) posture ───────────────────

  test("CUTOVER: missing X-Mimir-User-Id is silently stamped to the default user (the census mis-stamp, as run evidence)", async () => {
    // A write with NO user header — today this does not 401…
    const w = await fetch(`${CUTOVER_URL}/api/retain`, {
      method: "POST",
      headers: { ...auth, ...json },
      body: JSON.stringify({
        content: "Unattributed synthetic note about the aquarium filter schedule",
        source: "chat",
      }),
    });
    expect(w.status).toBe(200);

    // …and the record now belongs to the DEFAULT user's tenant.
    const asDefault = await fetch(`${CUTOVER_URL}/api/recall?q=aquarium%20filter`, {
      headers: { ...auth, "X-Mimir-User-Id": "user_default_kyle" },
    });
    const body = (await asDefault.json()) as { results: Array<{ content: string }> };
    const misStamped = body.results.some((r) => r.content.includes("aquarium"));
    console.error(`[dive:Q5] cutover mis-stamp demonstrated: unattributed write visible to default user = ${misStamped}`);
    expect(misStamped).toBe(true);
    // This is the September blocker in one assertion: under the current
    // posture, any caller that fails to thread the per-user id writes
    // into the default user's (Kyle's) tenant instead of failing loudly.
    // The flip to ENFORCED must land before minors arrive (census:
    // remove fallback at proxy.resolveCallerUserId + this service gate).
  }, 60_000);
});
