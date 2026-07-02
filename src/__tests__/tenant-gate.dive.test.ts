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
 * Two service configurations (Identity Session 2, 2026-07-02 — the
 * cutover fallback is DELETED from service.ts, so both must fail closed):
 *   ENFORCED    (MIMIR_REQUIRE_TENANT_HEADER=true, no default-user set)
 *     — the fail-closed posture September requires.
 *   LEGACY-ENV  (gate=false, GOBOT_DEFAULT_USER_ID set — the exact env
 *     that used to re-arm the mis-stamp fallback)
 *     — asserts the gate can no longer be re-armed by env flip: an
 *       unattributed write 401s and lands in NO tenant. This scenario
 *       previously (pre-Session-2) demonstrated the census mis-stamp
 *       leak: the same request returned 200 and was silently stamped
 *       into the default user's tenant.
 *
 * Also drives the REAL MCP proxy (src/proxy.ts) over stdio against the
 * enforced service to pin the two surviving identity tiers (actor,
 * explicit) + the fail-closed none tier and the X-Mimir-Id-Source
 * telemetry.
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
const LEGACY_ENV_PORT = 4298;
const ENFORCED_URL = `http://localhost:${ENFORCED_PORT}`;
const LEGACY_ENV_URL = `http://localhost:${LEGACY_ENV_PORT}`;

let enforcedProc: ReturnType<typeof Bun.spawn> | null = null;
let legacyEnvProc: ReturnType<typeof Bun.spawn> | null = null;

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

// Module-scoped so both describe blocks (HTTP boundary + MCP proxy tiers)
// share the same isolated service instances.
beforeAll(async () => {
  enforcedProc = spawnService(ENFORCED_PORT, `/tmp/mimir-dive-gate-enforced-${Date.now()}`, {
    MIMIR_REQUIRE_TENANT_HEADER: "true",
    GOBOT_DEFAULT_USER_ID: "", // no fallback exists in the enforced posture
  });
  // The exact env combination that pre-Session-2 re-armed the mis-stamp
  // fallback. Both vars are now inert — this instance must fail closed too.
  legacyEnvProc = spawnService(LEGACY_ENV_PORT, `/tmp/mimir-dive-gate-legacy-env-${Date.now()}`, {
    MIMIR_REQUIRE_TENANT_HEADER: "false",
    GOBOT_DEFAULT_USER_ID: "user_default_kyle",
  });
  await Promise.all([waitHealthy(ENFORCED_URL), waitHealthy(LEGACY_ENV_URL)]);
}, 60_000);

afterAll(async () => {
  enforcedProc?.kill();
  legacyEnvProc?.kill();
});

describe("Q5 — tenant gate at the HTTP boundary (isolated service instances)", () => {
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

  // ── LEGACY-ENV posture (Identity Session 2 flip) ───────────
  // Pre-Session-2 this scenario DEMONSTRATED the leak: the unattributed
  // write returned 200 and was silently stamped into user_default_kyle's
  // tenant. The fallback branch is now deleted from service.ts, so the
  // same env + same request must 401 and write to NO tenant.

  test("LEGACY-ENV: cutover env can no longer re-arm the fallback — unattributed write 401s and lands in NO tenant", async () => {
    // A write with NO user header, against a service whose env still sets
    // MIMIR_REQUIRE_TENANT_HEADER=false + GOBOT_DEFAULT_USER_ID.
    const w = await fetch(`${LEGACY_ENV_URL}/api/retain`, {
      method: "POST",
      headers: { ...auth, ...json },
      body: JSON.stringify({
        content: "Unattributed synthetic note about the aquarium filter schedule",
        source: "chat",
      }),
    });
    expect(w.status).toBe(401);
    const wBody = (await w.json()) as { error: string };
    expect(wBody.error).toContain("X-Mimir-User-Id");

    // Unattributed reads fail closed too.
    const read = await fetch(`${LEGACY_ENV_URL}/api/recall?q=aquarium%20filter`, {
      headers: auth,
    });
    expect(read.status).toBe(401);

    // And nothing landed in the would-be default tenant.
    const asDefault = await fetch(`${LEGACY_ENV_URL}/api/recall?q=aquarium%20filter`, {
      headers: { ...auth, "X-Mimir-User-Id": "user_default_kyle" },
    });
    expect(asDefault.status).toBe(200);
    const body = (await asDefault.json()) as { results: Array<{ content: string }> };
    const misStamped = body.results.some((r) => r.content.includes("aquarium"));
    console.error(
      `[dive:Q5→S2] legacy cutover env: unattributed write status=${w.status}; ` +
        `visible to default user = ${misStamped} (fail-closed holds)`,
    );
    expect(misStamped).toBe(false);
  }, 60_000);
});

// ─── Identity Session 2 — the REAL MCP proxy over stdio ─────
//
// Drives src/proxy.ts as a subprocess (newline-delimited JSON-RPC, the
// MCP stdio framing) against the ENFORCED service instance. Pins the two
// surviving identity tiers, the fail-closed none tier (with the deleted
// GOBOT_DEFAULT_USER_ID tier explicitly set in env to prove it stays
// dead), and the X-Mimir-Id-Source stderr telemetry.

type McpResult = {
  result?: { content: Array<{ type: string; text: string }>; isError?: boolean };
};

async function mcpToolCall(
  identityEnv: Record<string, string>,
  tool: string,
  args: Record<string, unknown>,
): Promise<{ response: McpResult | null; stderr: string }> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  // Strip ALL identity tiers from the inherited env, then apply only the
  // scenario's own — the whole point is controlling which tier resolves.
  delete env.MOSSCAP_ACTOR_USER_ID;
  delete env.MIMIR_USER_ID;
  delete env.GOBOT_DEFAULT_USER_ID;
  Object.assign(env, identityEnv, {
    MIMIR_URL: ENFORCED_URL,
    MIMIR_SHARED_SECRET: SECRET,
  });

  const proc = Bun.spawn(["bun", "run", "src/proxy.ts"], {
    cwd: import.meta.dir + "/../..",
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const send = (obj: unknown) => proc.stdin.write(JSON.stringify(obj) + "\n");
  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "identity-s2-test", version: "0.0.0" },
    },
  });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: args } });
  proc.stdin.flush();

  const decoder = new TextDecoder();
  const reader = proc.stdout.getReader();
  let buf = "";
  let response: McpResult | null = null;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && response === null) {
    const chunk = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value: undefined }>((r) =>
        setTimeout(() => r({ done: true, value: undefined }), deadline - Date.now()),
      ),
    ]);
    if (chunk.done) break;
    buf += decoder.decode(chunk.value);
    for (const line of buf.split("\n")) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id === 2) response = msg as McpResult;
      } catch {
        // partial line — keep buffering
      }
    }
  }
  proc.kill();
  const stderr = await new Response(proc.stderr).text();
  return { response, stderr };
}

describe("Identity Session 2 — MCP proxy identity tiers (fail-closed, telemetry)", () => {
  test("none tier: unattributed MCP retain fails with an explicit 401 and writes to NO tenant (GOBOT_DEFAULT_USER_ID in env stays dead)", async () => {
    const { response, stderr } = await mcpToolCall(
      // The deleted tier's env var is deliberately SET — it must not resolve.
      { GOBOT_DEFAULT_USER_ID: "user_default_kyle" },
      "retain",
      { content: "Orphaned synthetic note about the xylophone maintenance rota", source: "chat" },
    );
    expect(response).not.toBeNull();
    expect(response!.result?.isError).toBe(true);
    const text = response!.result!.content[0]!.text;
    expect(text).toContain("401");
    expect(text).toContain("X-Mimir-User-Id");
    // Telemetry: the proxy logged the none tier.
    expect(stderr).toContain("id-source=none");

    // The write landed in NO tenant — not the would-be default user's.
    const asDefault = await fetch(`${ENFORCED_URL}/api/recall?q=xylophone%20maintenance`, {
      headers: { ...auth, "X-Mimir-User-Id": "user_default_kyle" },
    });
    const body = (await asDefault.json()) as { results: Array<{ content: string }> };
    expect(body.results.some((r) => r.content.includes("xylophone"))).toBe(false);
    console.error(
      `[identity-s2] proxy none tier: isError=${response!.result?.isError}; ` +
        `default-tenant leak=${body.results.some((r) => r.content.includes("xylophone"))}`,
    );
  }, 60_000);

  test("actor tier (daemon path): MOSSCAP_ACTOR_USER_ID resolves, retain lands in the actor's tenant", async () => {
    const { response, stderr } = await mcpToolCall(
      { MOSSCAP_ACTOR_USER_ID: "teacher_actor" },
      "retain",
      { content: "Actor-tier synthetic note about the terrarium humidity log", source: "voice" },
    );
    expect(response).not.toBeNull();
    expect(response!.result?.isError).not.toBe(true);
    expect(stderr).toContain("id-source=actor");

    const own = await fetch(`${ENFORCED_URL}/api/recall?q=terrarium%20humidity`, {
      headers: { ...auth, "X-Mimir-User-Id": "teacher_actor" },
    });
    const ownBody = (await own.json()) as { results: Array<{ content: string }> };
    expect(ownBody.results.some((r) => r.content.includes("terrarium"))).toBe(true);

    const cross = await fetch(`${ENFORCED_URL}/api/recall?q=terrarium%20humidity`, {
      headers: { ...auth, "X-Mimir-User-Id": "student_b" },
    });
    const crossBody = (await cross.json()) as { results: Array<{ content: string }> };
    expect(crossBody.results.some((r) => r.content.includes("terrarium"))).toBe(false);
    console.error(
      `[identity-s2] proxy actor tier: owner sees ${ownBody.results.length}, other tenant sees 0 matching`,
    );
  }, 60_000);

  test("explicit tier (interactive path): MIMIR_USER_ID resolves, retain lands in the asserted tenant", async () => {
    const { response, stderr } = await mcpToolCall(
      { MIMIR_USER_ID: "user_interactive" },
      "retain",
      { content: "Explicit-tier synthetic note about the marimba practice schedule", source: "manual" },
    );
    expect(response).not.toBeNull();
    expect(response!.result?.isError).not.toBe(true);
    expect(stderr).toContain("id-source=explicit");

    const own = await fetch(`${ENFORCED_URL}/api/recall?q=marimba%20practice`, {
      headers: { ...auth, "X-Mimir-User-Id": "user_interactive" },
    });
    const ownBody = (await own.json()) as { results: Array<{ content: string }> };
    expect(ownBody.results.some((r) => r.content.includes("marimba"))).toBe(true);
    console.error(`[identity-s2] proxy explicit tier: owner sees ${ownBody.results.length}`);
  }, 60_000);

  test("actor tier outranks explicit when both are set (per-turn identity wins)", async () => {
    const { response, stderr } = await mcpToolCall(
      { MOSSCAP_ACTOR_USER_ID: "teacher_actor", MIMIR_USER_ID: "user_interactive" },
      "retain",
      { content: "Priority synthetic note about the sundial calibration walk", source: "chat" },
    );
    expect(response).not.toBeNull();
    expect(response!.result?.isError).not.toBe(true);
    expect(stderr).toContain("id-source=actor");

    const asActor = await fetch(`${ENFORCED_URL}/api/recall?q=sundial%20calibration`, {
      headers: { ...auth, "X-Mimir-User-Id": "teacher_actor" },
    });
    const actorBody = (await asActor.json()) as { results: Array<{ content: string }> };
    expect(actorBody.results.some((r) => r.content.includes("sundial"))).toBe(true);

    const asExplicit = await fetch(`${ENFORCED_URL}/api/recall?q=sundial%20calibration`, {
      headers: { ...auth, "X-Mimir-User-Id": "user_interactive" },
    });
    const explicitBody = (await asExplicit.json()) as { results: Array<{ content: string }> };
    expect(explicitBody.results.some((r) => r.content.includes("sundial"))).toBe(false);
  }, 60_000);
});
