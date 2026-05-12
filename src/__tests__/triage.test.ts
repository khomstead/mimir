import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { initGraph, closeGraph, createNode, createEdge } from "../graph.js";
import { triage } from "../verbs/triage.js";
import type { TenantStamp, TenantFilter } from "../types.js";

const TEST_DATA_PATH = `/tmp/mimir-triage-test-${Date.now()}`;
const TEST_TENANT: TenantStamp = { userId: "test_user_triage" };
const TEST_FILTER: TenantFilter = { callerUserId: "test_user_triage" };

describe("triage verb", () => {
  beforeAll(async () => {
    await initGraph(TEST_DATA_PATH);

    const entityId = await createNode("Entity", {
      name: "Catherine",
      type: "person",
      summary: "School project collaborator",
      synonyms: ["catherine"],
      created_at: Date.now(),
      updated_at: Date.now(),
    }, TEST_TENANT);

    const thoughtId = await createNode("Thought", {
      content: "Catherine and I discussed curriculum updates",
      embedding: new Array(1536).fill(0),
      source: "chat",
      confidence: 0.8,
      created_at: Date.now(),
    }, TEST_TENANT);
    await createEdge("Thought", thoughtId, "Entity", entityId, "contributes_to");

    await createNode("Anchor", {
      content: "Trust is foundational",
      domain: "education",
      weight: 1.0,
      created_at: Date.now(),
    }, TEST_TENANT);
  });

  afterAll(async () => {
    await closeGraph();
  });

  test("returns TriageResponse structure", async () => {
    const result = await triage(
      "Hi, following up on our conversation about the curriculum",
      "Catherine",
      TEST_FILTER,
      "email",
    );
    expect(result).toHaveProperty("signal_id");
    expect(result).toHaveProperty("priority");
    expect(result).toHaveProperty("routing");
    expect(result).toHaveProperty("related_entities");
    expect(result).toHaveProperty("related_anchors");
    expect(result).toHaveProperty("context_summary");
    expect(result).toHaveProperty("action_required");
  });

  test("identifies known entity in source", async () => {
    const result = await triage(
      "Meeting notes from today",
      "Catherine",
      TEST_FILTER,
    );
    expect(result.related_entities).toContain("Catherine");
  });

  test("identifies entities in content", async () => {
    const result = await triage(
      "I heard from Catherine about the project update",
      "unknown@email.com",
      TEST_FILTER,
    );
    expect(result.related_entities).toContain("Catherine");
  });

  test("detects anchor-related signal as high priority", async () => {
    const result = await triage(
      "The education department is changing their standards",
      "admin@school.org",
      TEST_FILTER,
    );
    expect(result.related_anchors.length).toBeGreaterThan(0);
    expect(result.priority).toBe("high");
    expect(result.routing).toBe("surface_immediately");
  });

  test("detects action-required language", async () => {
    const result = await triage(
      "URGENT: Please respond about the deadline for the grant application",
      "unknown@email.com",
      TEST_FILTER,
    );
    expect(result.action_required).toBe(true);
    expect(["high", "medium"]).toContain(result.priority);
  });

  test("classifies noise correctly", async () => {
    const result = await triage(
      "ok thanks",
      "unknown",
      TEST_FILTER,
    );
    expect(result.priority).toBe("noise");
    expect(result.routing).toBe("archive");
  });

  test("medium priority for known entity with recent activity", async () => {
    const result = await triage(
      "Catherine mentioned she has updates on the plan",
      "team@slack.com",
      TEST_FILTER,
    );
    expect(["high", "medium"]).toContain(result.priority);
  });
});
