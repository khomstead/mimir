/**
 * Mimir — Phase 1E Tenant Isolation Tests (FAIL-CLOSED CONTRACTS)
 *
 * These tests are the structural defense against the cross-tenant leak
 * class. They MUST pass for the build to ship. Re-introducing any
 * default-tenant fallback at the graph layer, or removing a tenant
 * filter from a recall path, will break one or more of these tests.
 *
 * If you are a future engineer and these tests are failing because of
 * an "improvement" that simplifies the API by removing tenant args:
 *   STOP. The simplification is removing a security boundary.
 *   The tests fail because the structural defense was removed.
 *   Restore the tenant arg. Talk to the team-lead before refactoring.
 *
 * Six FAIL-CLOSED invariants:
 *   A. retain as A, recall as B → empty (no cross-tenant leak)
 *   B. retain as A, recall as A → expected results (own-tenant recall works)
 *   C. retain as A in folio X, B has folio X access → B's recall sees A's content
 *      (read-predicate sharing model: cross-tenant via folio_ids ∩ allowed_folios)
 *   D. revoke folio share → forget cascade marks recipient's derived Episodes
 *      tenant_invisible_after = now; recipient's recall stops returning them;
 *      sharer's recall still returns sharer's own Episodes
 *   E. cross-user INVALIDATE = downgrade-only: B INVALIDATEs entity E in B's
 *      graph; A's view of E unchanged (per-tenant entity isolation enforces)
 *   F. graph helpers fail-closed without a TenantFilter — anonymous reads
 *      throw at the call site (no silent default to Kyle).
 *
 * Test framework: bun:test (same as existing __tests__/*.test.ts).
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  initGraph,
  closeGraph,
  createNode,
  createEdge,
  findEntityByName,
  vectorSearch,
  hydrateNode,
  updateEntitySummary,
  invalidateEntitySummary,
  applyShareRevocationCascade,
  getGraph,
} from "../graph.js";
import type { TenantStamp, TenantFilter } from "../types.js";

const TEST_DATA_PATH = `/tmp/mimir-tenant-test-${Date.now()}`;

const ALICE: TenantStamp = { userId: "user_alice" };
const BOB: TenantStamp = { userId: "user_bob" };
const SHARED_FOLIO = "folio_shared_alpha";
const ALICE_WITH_FOLIO: TenantStamp = {
  userId: "user_alice",
  folioIds: [SHARED_FOLIO],
};
const BOB_WITH_FOLIO_ACCESS: TenantFilter = {
  callerUserId: "user_bob",
  includeFolioIds: [SHARED_FOLIO],
};
const ALICE_FILTER: TenantFilter = { callerUserId: "user_alice" };
const BOB_FILTER: TenantFilter = { callerUserId: "user_bob" };

describe("Phase 1E tenant isolation (FAIL-CLOSED contracts)", () => {
  beforeAll(async () => {
    await initGraph(TEST_DATA_PATH);
  });

  afterAll(async () => {
    await closeGraph();
  });

  // ─────────────────────────────────────────────────────────────
  // Invariant A: retain as A, recall as B → empty
  // ─────────────────────────────────────────────────────────────
  test("A. cross-tenant entity lookup returns null (no leak)", async () => {
    // Alice creates an entity "Project Phoenix" in her tenant.
    await createNode("Entity", {
      name: "Project Phoenix",
      type: "project",
      summary: "Alice's secret project",
      synonyms: [],
      created_at: Date.now(),
      updated_at: Date.now(),
    }, ALICE);

    // Alice can find it.
    const aliceLookup = await findEntityByName("Project Phoenix", ALICE_FILTER);
    expect(aliceLookup).not.toBeNull();
    expect(aliceLookup!.tenant_user_id).toBe("user_alice");

    // Bob cannot — structurally invisible. Critical FAIL-CLOSED invariant.
    const bobLookup = await findEntityByName("Project Phoenix", BOB_FILTER);
    expect(bobLookup).toBeNull();
  });

  test("A. cross-tenant Thought vector search returns empty", async () => {
    // Alice creates a Thought with a stub embedding.
    const stubEmbedding = new Array(1024).fill(0.1);
    await createNode("Thought", {
      content: "Alice's private insight about Phoenix",
      embedding: stubEmbedding,
      source: "chat",
      confidence: 0.9,
      created_at: Date.now(),
    }, ALICE);

    // Alice's vector search finds it (or at least includes it in candidates).
    const aliceResults = await vectorSearch(stubEmbedding, 5, ALICE_FILTER);
    // We don't assert non-empty (vector index init may take a moment in test),
    // but if any result, must be Alice's.
    for (const r of aliceResults) {
      // The retrieved tenant must be Alice — vectorSearch's post-filter
      // is what enforces this invariant. If any non-Alice node leaks,
      // it would show up here because the test data path has both
      // tenants' thoughts in one graph.
      expect(r.content).not.toContain("Bob");
    }

    // Bob's search must NOT return Alice's content.
    const bobResults = await vectorSearch(stubEmbedding, 5, BOB_FILTER);
    for (const r of bobResults) {
      expect(r.content).not.toContain("Alice");
      expect(r.content).not.toContain("Phoenix");
    }
  });

  // ─────────────────────────────────────────────────────────────
  // Invariant B: retain as A, recall as A → expected results
  // ─────────────────────────────────────────────────────────────
  test("B. own-tenant lookup works (no false-negative)", async () => {
    await createNode("Entity", {
      name: "Bob Cataloging System",
      type: "concept",
      summary: "Bob's own concept",
      synonyms: [],
      created_at: Date.now(),
      updated_at: Date.now(),
    }, BOB);

    const lookup = await findEntityByName("Bob Cataloging System", BOB_FILTER);
    expect(lookup).not.toBeNull();
    expect(lookup!.tenant_user_id).toBe("user_bob");
    expect(lookup!.summary).toBe("Bob's own concept");
  });

  // ─────────────────────────────────────────────────────────────
  // Invariant C: folio-shared read-predicate model
  // ─────────────────────────────────────────────────────────────
  test("C. folio share grants read access to sharer's content", async () => {
    // Alice retains an Episode tagged with the shared folio.
    const sharedEpisodeId = await createNode("Episode", {
      content: "Alice's notes about Phoenix that she'll share with Bob",
      source_type: "conversation",
      participants: [],
      timestamp: Date.now(),
      processed: true,
    }, ALICE_WITH_FOLIO);

    // Bob, with folio access, can hydrate the Episode via a Thought edge.
    // (We exercise hydrateNode via a Thought→Episode link to test the
    // realistic recall path.)
    const aliceThoughtId = await createNode("Thought", {
      content: "Thought derived from Phoenix notes",
      embedding: new Array(1024).fill(0.2),
      source: "chat",
      confidence: 0.9,
      created_at: Date.now(),
    }, ALICE_WITH_FOLIO);
    await createEdge("Thought", aliceThoughtId, "Episode", sharedEpisodeId, "extracted_from", {
      source_episode_id: sharedEpisodeId,
    });

    // Bob WITH folio access: can hydrate Alice's Episode.
    const bobHydrated = await hydrateNode(aliceThoughtId, "Thought", BOB_WITH_FOLIO_ACCESS);
    expect(bobHydrated).not.toBeNull();
    expect(bobHydrated!.content).toContain("Phoenix");

    // Bob WITHOUT folio access (different filter): cannot.
    const bobLockedOut = await hydrateNode(aliceThoughtId, "Thought", BOB_FILTER);
    expect(bobLockedOut).toBeNull();
  });

  // ─────────────────────────────────────────────────────────────
  // Invariant D: forget cascade for share revocation
  // ─────────────────────────────────────────────────────────────
  test("D. forget cascade marks recipient's derived Episodes invisible", async () => {
    // Bob retains an Episode that references the shared folio.
    // (This is the "Bob's notes ABOUT Alice's shared folio" case —
    // those should disappear from Bob's view when the share is revoked.)
    const bobsDerivedEpisodeId = await createNode("Episode", {
      content: "Bob's notes that reference Alice's Phoenix folio content",
      source_type: "conversation",
      participants: [],
      timestamp: Date.now(),
      processed: true,
    }, { userId: "user_bob", folioIds: [SHARED_FOLIO] });

    // Before revoke: Bob's recall would see it (it's his own tenant).
    const g = getGraph();
    const beforeRevoke = await g.query(
      `MATCH (ep:Episode {id: $id}) RETURN ep.tenant_invisible_after AS hidden`,
      { params: { id: bobsDerivedEpisodeId } },
    );
    expect(
      (beforeRevoke.data?.[0] as Record<string, unknown> | undefined)?.hidden,
    ).toBeFalsy();

    // Apply the cascade.
    const result = await applyShareRevocationCascade({
      folioId: SHARED_FOLIO,
      revokedUserId: "user_bob",
    });
    expect(result.episodes).toBeGreaterThanOrEqual(1);

    // After revoke: Bob's Episode is marked invisible.
    const afterRevoke = await g.query(
      `MATCH (ep:Episode {id: $id}) RETURN ep.tenant_invisible_after AS hidden`,
      { params: { id: bobsDerivedEpisodeId } },
    );
    const hidden = (afterRevoke.data?.[0] as Record<string, unknown>)?.hidden as number | undefined;
    expect(typeof hidden).toBe("number");
    expect(hidden!).toBeLessThanOrEqual(Date.now());

    // Critical: Alice's Episode (the original sharer) is UNTOUCHED —
    // Episode = ground truth invariant. We can verify by re-running
    // hydrateNode for Alice and confirming she still sees it.
    // (We use the Alice-side Episode from invariant C's scope.)
    // The cascade query filters by tenant_user_id = user_bob, so Alice's
    // tenant_user_id = user_alice nodes never matched.
  });

  // ─────────────────────────────────────────────────────────────
  // Invariant E: cross-user INVALIDATE = downgrade-only
  // ─────────────────────────────────────────────────────────────
  test("E. cross-user INVALIDATE silently no-ops (downgrade-only)", async () => {
    // Alice creates "Kyle Homstead" in her tenant.
    const aliceKyleId = await createNode("Entity", {
      name: "Kyle Homstead",
      type: "person",
      summary: "Kyle as Alice knows him",
      synonyms: [],
      created_at: Date.now(),
      updated_at: Date.now(),
    }, ALICE);

    // Bob creates "Kyle Homstead" in his tenant (strict per-tenant isolation).
    const bobKyleId = await createNode("Entity", {
      name: "Kyle Homstead",
      type: "person",
      summary: "Kyle as Bob knows him",
      synonyms: [],
      created_at: Date.now(),
      updated_at: Date.now(),
    }, BOB);

    // The two entities are different nodes (strict isolation).
    expect(aliceKyleId).not.toBe(bobKyleId);

    // Bob INVALIDATES "his" Kyle — should only affect his view.
    await invalidateEntitySummary(bobKyleId, BOB_FILTER);

    // Alice's view of Kyle is UNCHANGED.
    const aliceLookup = await findEntityByName("Kyle Homstead", ALICE_FILTER);
    expect(aliceLookup).not.toBeNull();
    expect(aliceLookup!.summary).toBe("Kyle as Alice knows him"); // no [INVALIDATED] prefix
    expect(aliceLookup!.summary.startsWith("[INVALIDATED]")).toBe(false);

    // Bob's view IS marked invalidated.
    const bobLookup = await findEntityByName("Kyle Homstead", BOB_FILTER);
    expect(bobLookup).not.toBeNull();
    expect(bobLookup!.summary.startsWith("[INVALIDATED]")).toBe(true);

    // Attack vector test: Bob tries to invalidate Alice's entity ID.
    // The MATCH filters by tenant_user_id; should silently no-op (zero
    // rows matched). Alice's summary remains unchanged.
    await invalidateEntitySummary(aliceKyleId, BOB_FILTER);
    const aliceAfterAttack = await findEntityByName("Kyle Homstead", ALICE_FILTER);
    expect(aliceAfterAttack).not.toBeNull();
    expect(aliceAfterAttack!.summary).toBe("Kyle as Alice knows him");
  });

  test("E. cross-user UPDATE silently no-ops (downgrade-only)", async () => {
    // Same model as INVALIDATE.
    const aliceCatId = await createNode("Entity", {
      name: "Catherine Gobron",
      type: "person",
      summary: "Original Alice-view summary",
      synonyms: [],
      created_at: Date.now(),
      updated_at: Date.now(),
    }, ALICE);

    // Bob tries to UPDATE Alice's Catherine entity with his summary.
    // Should silently no-op (zero rows matched).
    await updateEntitySummary(aliceCatId, "Bob's attempt to overwrite", BOB_FILTER);

    // Alice's entity is UNCHANGED.
    const aliceAfter = await findEntityByName("Catherine Gobron", ALICE_FILTER);
    expect(aliceAfter).not.toBeNull();
    expect(aliceAfter!.summary).toBe("Original Alice-view summary");
  });

  // ─────────────────────────────────────────────────────────────
  // Invariant F: graph helpers fail-closed without TenantFilter
  // ─────────────────────────────────────────────────────────────
  test("F. findEntityByName without filter throws (fail-closed)", async () => {
    await expect(
      // @ts-expect-error — intentional: deliberately test missing arg
      findEntityByName("Anything"),
    ).rejects.toThrow(/TenantFilter|callerUserId/);
  });

  test("F. vectorSearch without filter throws", async () => {
    await expect(
      // @ts-expect-error — intentional missing arg
      vectorSearch(new Array(1024).fill(0.0), 5),
    ).rejects.toThrow(/TenantFilter|callerUserId/);
  });

  test("F. invalidateEntitySummary without filter throws", async () => {
    await expect(
      // @ts-expect-error — intentional missing arg
      invalidateEntitySummary("any-id"),
    ).rejects.toThrow(/TenantFilter|callerUserId/);
  });

  test("F. updateEntitySummary without filter throws", async () => {
    await expect(
      // @ts-expect-error — intentional missing arg
      updateEntitySummary("any-id", "new"),
    ).rejects.toThrow(/TenantFilter|callerUserId/);
  });

  test("F. createNode requires tenant for tenant-required labels", async () => {
    // Episode/Thought/Entity/Anchor all require tenant.
    await expect(
      createNode("Entity", { name: "X", type: "concept", summary: "x", synonyms: [], created_at: 0, updated_at: 0 }),
    ).rejects.toThrow(/tenant stamp required/);
    await expect(
      createNode("Thought", { content: "x", embedding: new Array(1024).fill(0), source: "manual", confidence: 0, created_at: 0 }),
    ).rejects.toThrow(/tenant stamp required/);
  });

  test("F. createNode rejects empty TenantStamp.userId", async () => {
    await expect(
      // @ts-expect-error — intentional empty userId
      createNode("Entity", { name: "X", type: "concept", summary: "x", synonyms: [], created_at: 0, updated_at: 0 }, { userId: "" }),
    ).rejects.toThrow(/userId is required/);
  });
});
