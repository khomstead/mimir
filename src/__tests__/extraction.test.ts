import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  extractFromText,
  fallbackExtraction,
  deferredExtraction,
  validateEntityType,
  validateEdgeType,
} from "../extraction.js";

describe("extraction", () => {
  let originalKey: string | undefined;
  let originalDisable: string | undefined;

  beforeEach(() => {
    // Save state and force deferred mode (BRAIN_DISABLE_LLM bypasses .env fallback)
    originalKey = process.env.ANTHROPIC_API_KEY;
    originalDisable = process.env.BRAIN_DISABLE_LLM;
    delete process.env.ANTHROPIC_API_KEY;
    process.env.BRAIN_DISABLE_LLM = "true";
  });

  afterEach(() => {
    // Restore
    if (originalKey) process.env.ANTHROPIC_API_KEY = originalKey;
    else delete process.env.ANTHROPIC_API_KEY;
    if (originalDisable) process.env.BRAIN_DISABLE_LLM = originalDisable;
    else delete process.env.BRAIN_DISABLE_LLM;
  });

  test("returns deferred extraction when no API key (queue pattern)", async () => {
    const result = await extractFromText(
      "Kyle and Catherine discussed the school project over dinner.",
    );
    expect(result).toHaveProperty("queued", true);
    expect(result.entities).toEqual([]);
    expect(result.relationships).toEqual([]);
    expect(result.confidence).toBe(0);
    expect(result.domains).toEqual([]);
  });

  test("deferredExtraction returns correct sentinel structure", () => {
    const result = deferredExtraction();
    expect(result.queued).toBe(true);
    expect(result.entities).toEqual([]);
    expect(result.confidence).toBe(0);
  });

  test("fallback extracts capitalized names as entities", () => {
    const result = fallbackExtraction(
      "Kyle and Catherine discussed the school project.",
    );
    const names = result.entities.map((e) => e.name);
    expect(names).toContain("Kyle");
    expect(names).toContain("Catherine");
  });

  test("fallback entities have canonical_name", () => {
    const result = fallbackExtraction("Kyle Homstead went to the store.");
    const kyle = result.entities.find((e) => e.name === "Kyle Homstead");
    expect(kyle).toBeDefined();
    expect(kyle!.canonical_name).toBe("kyle_homstead");
  });

  test("fallback returns empty relationships", () => {
    const result = fallbackExtraction("Any text here.");
    expect(result.relationships).toEqual([]);
  });

  test("fallback is_anchor is always false", () => {
    const result = fallbackExtraction("I believe in radical honesty.");
    expect(result.is_anchor).toBe(false);
  });

  test("fallback commitment and deadline are null", () => {
    const result = fallbackExtraction("I need to call the board by Friday.");
    expect(result.commitment).toBeNull();
    expect(result.deadline).toBeNull();
  });

  test("fallback domains are empty", () => {
    const result = fallbackExtraction("Work stuff.");
    expect(result.domains).toEqual([]);
  });

  describe("validators", () => {
    test("validateEntityType accepts valid types", () => {
      expect(validateEntityType("person")).toBe("person");
      expect(validateEntityType("org")).toBe("org");
      expect(validateEntityType("project")).toBe("project");
      expect(validateEntityType("concept")).toBe("concept");
      expect(validateEntityType("domain")).toBe("domain");
    });

    test("validateEntityType falls back to concept for invalid types", () => {
      expect(validateEntityType("invalid")).toBe("concept");
      expect(validateEntityType("")).toBe("concept");
      expect(validateEntityType("PERSON")).toBe("concept");
    });

    test("validateEdgeType accepts valid types", () => {
      expect(validateEdgeType("relates_to")).toBe("relates_to");
      expect(validateEdgeType("constrains")).toBe("constrains");
      expect(validateEdgeType("involves")).toBe("involves");
      expect(validateEdgeType("tensions_with")).toBe("tensions_with");
    });

    test("validateEdgeType falls back to relates_to for invalid types", () => {
      expect(validateEdgeType("invalid")).toBe("relates_to");
      expect(validateEdgeType("")).toBe("relates_to");
      expect(validateEdgeType("RELATES_TO")).toBe("relates_to");
    });
  });
});
