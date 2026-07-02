/**
 * Mimir Deep Dive — Q3: Proactive connection, or merely literal recall?
 * (fable-mimir-dive, 2026-07-01)
 *
 * The EA make-or-break: does the substrate surface non-obvious CORRECT
 * connections (semantic, multi-hop), or only literal/substring matches?
 *
 * Fixtures are designed so the RIGHT answer requires a non-literal jump:
 *   A. Semantic paraphrase — query shares zero content words (>3 chars)
 *      with the target thought; only the vector strategy can find it.
 *      Uses REAL local oMLX Qwen3 embeddings (the production embedder).
 *   B. Anchor search literalness — the anchor-relevant query has no
 *      substring overlap with anchor content/domain (verifies the
 *      "anchor-search-is-substring" hint against running code).
 *   C. Two-hop graph connection — A→B→C wired via connect(); does any
 *      read path surface C when asking about A?
 *   D. Multimodal front door — voice-transcript ingestion with event_at
 *      (bi-temporal) as first-class evidence.
 *
 * SANDBOX: isolated /tmp instance. BRAIN_DISABLE_LLM=true (no extraction
 * LLM); embeddings via local oMLX ($0).
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { initGraph, closeGraph, getGraph, createNode } from "../graph.js";
import { retain } from "../verbs/retain.js";
import { recall } from "../verbs/recall.js";
import { anchor } from "../verbs/anchor.js";
import { connect } from "../verbs/connect.js";
import { pulse } from "../verbs/pulse.js";
import type { TenantStamp, TenantFilter } from "../types.js";

const TEST_DATA_PATH = `/tmp/mimir-dive-proactive-${Date.now()}`;
const T: TenantStamp = { userId: "teacher_q3" };
const F: TenantFilter = { callerUserId: "teacher_q3" };

describe("Q3 — proactive vs literal (isolated instance, real local embeddings)", () => {
  beforeAll(async () => {
    await initGraph(TEST_DATA_PATH);

    // Fixture A corpus: 8 classroom observations, one true target for the
    // paraphrase query. Query will be "which student struggles with public
    // speaking" — the target shares NO content word >3 chars with it.
    await retain(
      "Marcus freezes when asked to read his writing aloud and avoids oral presentations entirely",
      "chat", [], undefined, T,
    );
    await retain("Dana finished her clay sculpture of a heron and documented the glazing process", "chat", [], undefined, T);
    await retain("The math attainment checkpoint showed strong fraction fluency across the cohort", "chat", [], undefined, T);
    await retain("Priya organized the community garden volunteers without any adult prompting", "chat", [], undefined, T);
    await retain("Attendance was thin on Friday because of the field trip permission mixup", "chat", [], undefined, T);
    await retain("Jonah's robotics build needs a new servo before the showcase", "chat", [], undefined, T);
    await retain("The morning meeting circle discussed how to welcome the new transfer kids", "chat", [], undefined, T);
    await retain("Lena rewrote her poem three times and asked for feedback on the final draft", "chat", [], undefined, T);
  }, 120_000);

  afterAll(async () => {
    await closeGraph();
  });

  test("A. semantic paraphrase with zero word overlap finds the right thought", async () => {
    const res = await recall("which student struggles with public speaking", F);
    expect(res.results.length).toBeGreaterThan(0);
    const top = res.results[0];
    console.error(
      `[dive:Q3A] top='${top.content.slice(0, 60)}…' score=${top.score} source=${top.source} strategies=${res.strategies_used}`,
    );
    expect(top.content).toContain("Marcus");
    // And it must have come from the semantic strategy (no substring possible).
    expect(top.source).toBe("semantic");
  }, 60_000);

  test("A2. concept-level query (the 'Light Cycle' failure class) via recall()", async () => {
    await retain(
      "The Light Cycle framework defines the school's graduation requirements: " +
        "learners advance by demonstrating mastery evidence, not by seat time or letter grades.",
      "document", [], undefined, T,
    );
    // Concept paraphrase, no shared content words with the stored name:
    const res = await recall("competency based assessment system", F);
    const hit = res.results.findIndex((r) => r.content.includes("Light Cycle"));
    console.error(`[dive:Q3A2] 'competency based assessment system' → Light Cycle doc at rank ${hit} (of ${res.results.length})`);
    expect(hit).toBeGreaterThanOrEqual(0); // semantic recall() CAN find it…
    // …the brief's production failure was /api/context, which has no
    // semantic strategy at all (service.ts:506-522, substring on first
    // 3 words). Documented in findings; asserted at the HTTP layer in
    // the Q5 gate test.
  }, 60_000);

  test("B. anchor search is literal substring — paraphrase query misses the anchor", async () => {
    await anchor(
      "Nothing falls through the cracks — every commitment is tracked to completion",
      "operating_principles",
      T,
    );

    // Paraphrase with no substring of content or domain:
    const miss = await recall("dropped follow-ups and forgotten promises", F);
    const anchorHitMiss = miss.results.some((r) => r.type === "anchor");
    // Literal substring of the anchor content:
    const hit = await recall("cracks", F);
    const anchorHitLiteral = hit.results.some((r) => r.type === "anchor");

    console.error(`[dive:Q3B] paraphrase→anchor=${anchorHitMiss} | literal 'cracks'→anchor=${anchorHitLiteral}`);
    expect(anchorHitLiteral).toBe(true);   // substring works…
    expect(anchorHitMiss).toBe(false);     // …semantics does not (recall.ts:340 CONTAINS only)
  }, 60_000);

  test("C. two-hop connections are not surfaced by any read path", async () => {
    const now = Date.now();
    // Entities: Marcus —contributes_to→ Empathy Goal —relates_to→ Peer Mediation Project
    await createNode("Entity", { name: "Marcus", type: "person", summary: "Student", synonyms: [], created_at: now, updated_at: now }, T);
    await createNode("Entity", { name: "Empathy Goal", type: "concept", summary: "Marcus's growth goal", synonyms: [], created_at: now, updated_at: now }, T);
    await createNode("Entity", { name: "Peer Mediation Project", type: "project", summary: "Conflict-resolution practicum", synonyms: [], created_at: now, updated_at: now }, T);
    await connect("Marcus", "Empathy Goal", F, "goal assignment", "contributes_to");
    await connect("Empathy Goal", "Peer Mediation Project", F, "project serves the goal", "relates_to");

    const p = await pulse("Marcus", F);
    const names = p.connections.map((c) => c.name);
    console.error(`[dive:Q3C] pulse('Marcus').connections = ${JSON.stringify(names)}`);
    expect(names).toContain("Empathy Goal");          // 1-hop: yes
    expect(names).not.toContain("Peer Mediation Project"); // 2-hop: structurally absent
    // (pulse.ts:156-167 — MATCH is single-hop in both directions; recall's
    // graphSearch (recall.ts:194-201) only decorates matched Thoughts with
    // their DIRECT entity names. No traversal-based retrieval exists.)
  }, 60_000);

  test("D. multimodal front door: voice transcript is first-class, bi-temporal", async () => {
    const yesterday = Date.now() - 24 * 3600 * 1000;
    const r = await retain(
      "Voice memo after third period: the mediation circle went long but Marcus stayed engaged the whole time",
      "voice", ["Marcus"], yesterday, T,
    );
    expect(r.stored).toBe(true);

    const g = getGraph();
    const ep = await g.query(
      `MATCH (ep:Episode {id: $id}) RETURN ep.source_type AS st, ep.event_at AS ea, ep.timestamp AS ts`,
      { params: { id: r.episode_id } },
    );
    const row = ep.data![0] as Record<string, unknown>;
    console.error(`[dive:Q3D] voice episode: source_type=${row.st} event_at=${row.ea} ingest=${row.ts}`);
    expect(row.st).toBe("voice");
    expect(row.ea).toBe(yesterday);            // event time ≠ ingest time — bi-temporal holds
    expect(row.ts as number).toBeGreaterThan(yesterday);
    // Image path: NONE — /api/retain accepts only body.content text
    // (service.ts:313-333); no bytes/attachment/URI field anywhere in the
    // API surface. Assessed in findings (Q-multimodal).
  }, 60_000);
});
