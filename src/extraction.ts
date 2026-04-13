/**
 * Mimir — LLM Entity/Relationship Extraction
 *
 * Uses Claude Haiku (by default) to extract entities, relationships,
 * anchors, commitments, and domains from raw text. Falls back to a
 * simple regex-based extractor when no ANTHROPIC_API_KEY is set.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { EntityType, EdgeType, ExtractionResult } from "./types.js";
import { findEntityByName } from "./graph.js";

// ─── Constants ──────────────────────────────────────────────

const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

const VALID_ENTITY_TYPES: Set<string> = new Set([
  "person",
  "org",
  "project",
  "concept",
  "domain",
]);

const VALID_EDGE_TYPES: Set<string> = new Set([
  "relates_to",
  "constrains",
  "extracted_from",
  "evolves",
  "supersedes",
  "involves",
  "contributes_to",
  "tensions_with",
  "authored_by",
  "scoped_to",
  "created_by",
  "demonstrates",
  "discussed_in",
  "progresses_from",
]);

// ─── Validators ─────────────────────────────────────────────

export function validateEntityType(value: string): EntityType {
  return VALID_ENTITY_TYPES.has(value) ? (value as EntityType) : "concept";
}

export function validateEdgeType(value: string): EdgeType {
  return VALID_EDGE_TYPES.has(value) ? (value as EdgeType) : "relates_to";
}

// ─── Extraction Prompt ──────────────────────────────────────

const EXTRACTION_PROMPT = `You are an entity/relationship extraction engine for a personal knowledge graph. Given text, extract structured information and return ONLY valid JSON (no markdown fences, no explanation).

Return this exact JSON structure:
{
  "entities": [
    { "name": "display name", "type": "person|org|project|concept|domain", "canonical_name": "normalized_snake_case" }
  ],
  "entity_actions": [
    {
      "name": "entity display name",
      "type": "person|org|project|concept|domain",
      "canonical_name": "normalized_snake_case",
      "fact_summary": "What this episode says about the entity — a complete, standalone description. NOT a fragment.",
      "action": "ADD|UPDATE|INVALIDATE"
    }
  ],
  "relationships": [
    { "from": "entity canonical name", "to": "entity canonical name", "type": "relates_to|constrains|involves|contributes_to|tensions_with|scoped_to|demonstrates|discussed_in|progresses_from", "rationale": "brief reason" }
  ],
  "facts": [
    {
      "from": "entity canonical name",
      "to": "entity canonical name",
      "edge_type": "relates_to|constrains|involves|contributes_to",
      "fact": "Full natural-language description of the relationship. Example: 'Kyle is the technical director of Lighthouse Holyoke'",
      "valid_at": "ISO 8601 datetime or null if unknown",
      "invalid_at": "ISO 8601 datetime or null if still true"
    }
  ],
  "is_anchor": false,
  "anchor_domain": null,
  "commitment": null,
  "deadline": null,
  "confidence": 0.7,
  "domains": []
}

ENTITY ACTION RULES:
- ADD: Entity is not in EXISTING ENTITIES below, or no existing entities provided.
- UPDATE: Entity exists but the new text adds, corrects, or expands what we know. The fact_summary should be a MERGED description combining old + new info.
- INVALIDATE: Entity exists but the new text CONTRADICTS the existing summary. This is rare.
- fact_summary must be a COMPLETE, STANDALONE description — not a fragment. Write it as if someone reading only this field would understand the entity's full context.

FACT RULES:
- facts[] stores the natural-language description of each relationship.
- Write facts as full sentences: "Catherine Gobron is the founder of Lighthouse Holyoke" not "founder".
- Include valid_at if the text implies when the relationship started.
- Include invalid_at if the text implies the relationship ended.

Rules:
- Extract entities: people, organizations, projects, concepts, domains mentioned in the text.
- Use canonical_name for dedup: if text mentions "the school" and "School Project", normalize to one canonical name like "school_project".
- is_anchor: true ONLY for deeply held philosophical beliefs, core values, or guiding principles. Be very conservative.
- commitment: if the text contains a promise or action item, extract it. Otherwise null.
- confidence: 0.0-1.0 how confident you are in the extraction quality.
- domains: list of life/work domains this text touches.

Return ONLY the JSON object. No other text.`;

// ─── Fallback Extractor ─────────────────────────────────────

/**
 * Sentinel result returned when no LLM is available.
 * Signals to retain() that extraction should be queued, not faked.
 * The `queued` flag distinguishes this from a real extraction result.
 */
export function deferredExtraction(): ExtractionResult & { queued: true } {
  return {
    queued: true,
    entities: [],
    relationships: [],
    is_anchor: false,
    anchor_domain: null,
    commitment: null,
    deadline: null,
    confidence: 0,
    domains: [],
  };
}

/**
 * Simple regex-based fallback when no LLM is available.
 * DEPRECATED: Only kept for backward-compatible test assertions.
 * Production path now uses deferredExtraction() + queue pattern.
 */
export function fallbackExtraction(text: string): ExtractionResult {
  // Very basic: extract capitalized words as potential person names
  const namePattern = /\b([A-Z][a-z]+(?:\s[A-Z][a-z]+)*)\b/g;
  const names = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = namePattern.exec(text)) !== null) {
    const name = match[1];
    // Filter out common sentence starters and short words
    if (name.length > 2 && !COMMON_WORDS.has(name.toLowerCase())) {
      names.add(name);
    }
  }

  const entities = Array.from(names).map((name) => ({
    name,
    type: "concept" as EntityType,
    canonical_name: name.toLowerCase().replace(/\s+/g, "_"),
  }));

  return {
    entities,
    relationships: [],
    is_anchor: false,
    anchor_domain: null,
    commitment: null,
    deadline: null,
    confidence: 0.1,
    domains: [],
  };
}

const COMMON_WORDS = new Set([
  "the",
  "this",
  "that",
  "then",
  "there",
  "their",
  "they",
  "some",
  "when",
  "what",
  "where",
  "which",
  "while",
  "with",
  "would",
  "could",
  "should",
  "have",
  "been",
  "from",
  "just",
  "also",
  "more",
  "most",
  "much",
  "many",
  "each",
  "every",
  "after",
  "before",
  "about",
  "into",
  "over",
  "such",
  "here",
  "only",
  "very",
  "well",
  "back",
  "even",
  "still",
  "already",
  "however",
  "because",
  "since",
  "until",
  "although",
  "though",
  "all",
  "these",
  "those",
  "decision",
  "collective",
  "not",
  "but",
  "for",
  "are",
  "was",
  "were",
  "will",
  "can",
  "our",
  "his",
  "her",
  "its",
  "your",
  "any",
  "both",
  "other",
  "same",
  "new",
  "now",
  "way",
  "may",
  "how",
  "who",
  "why",
]);

// ─── LLM Extraction ────────────────────────────────────────

/**
 * Look up existing entity summaries to provide context to the extraction LLM.
 * Returns a map of entity name → current summary for entities that exist.
 * This enables the LLM to decide ADD vs UPDATE vs INVALIDATE.
 */
async function getExistingEntityContext(
  text: string,
): Promise<Record<string, string>> {
  const namePattern = /\b([A-Z][a-z]+(?:\s[A-Z][a-z]+)*)\b/g;
  const candidates = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = namePattern.exec(text)) !== null) {
    if (match[1].length > 2) candidates.add(match[1]);
  }

  const context: Record<string, string> = {};
  for (const name of Array.from(candidates).slice(0, 10)) {
    const entity = await findEntityByName(name);
    if (entity) {
      context[entity.name] = entity.summary;
    }
  }
  return context;
}

/**
 * Parse and validate the LLM's JSON response into an ExtractionResult.
 * Falls back to fallbackExtraction if parsing fails.
 */
function parseExtractionResponse(
  raw: string,
  originalText: string,
): ExtractionResult {
  try {
    // Strip markdown fences if present
    let cleaned = raw.trim();
    if (cleaned.startsWith("```")) {
      cleaned = cleaned.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    }

    const parsed = JSON.parse(cleaned);

    // Validate and coerce the structure
    const entities = Array.isArray(parsed.entities)
      ? parsed.entities.map(
          (e: { name?: string; type?: string; canonical_name?: string }) => ({
            name: String(e.name ?? ""),
            type: validateEntityType(String(e.type ?? "concept")),
            canonical_name: e.canonical_name
              ? String(e.canonical_name)
              : undefined,
          }),
        )
      : [];

    const relationships = Array.isArray(parsed.relationships)
      ? parsed.relationships.map(
          (r: {
            from?: string;
            to?: string;
            type?: string;
            rationale?: string;
          }) => ({
            from: String(r.from ?? ""),
            to: String(r.to ?? ""),
            type: validateEdgeType(String(r.type ?? "relates_to")),
            rationale: String(r.rationale ?? ""),
          }),
        )
      : [];

    const entity_actions = Array.isArray(parsed.entity_actions)
      ? parsed.entity_actions.map(
          (ea: any) => ({
            name: String(ea.name ?? ""),
            type: validateEntityType(String(ea.type ?? "concept")),
            canonical_name: ea.canonical_name ? String(ea.canonical_name) : undefined,
            fact_summary: String(ea.fact_summary ?? ""),
            action: ["ADD", "UPDATE", "INVALIDATE"].includes(ea.action) ? ea.action : "ADD",
          }),
        )
      : undefined;

    const facts = Array.isArray(parsed.facts)
      ? parsed.facts.map(
          (f: any) => ({
            from: String(f.from ?? ""),
            to: String(f.to ?? ""),
            edge_type: validateEdgeType(String(f.edge_type ?? "relates_to")),
            fact: String(f.fact ?? ""),
            valid_at: f.valid_at ? String(f.valid_at) : null,
            invalid_at: f.invalid_at ? String(f.invalid_at) : null,
          }),
        )
      : undefined;

    return {
      entities,
      entity_actions,
      relationships,
      facts,
      is_anchor: Boolean(parsed.is_anchor),
      anchor_domain: parsed.anchor_domain
        ? String(parsed.anchor_domain)
        : null,
      commitment: parsed.commitment ? String(parsed.commitment) : null,
      deadline: parsed.deadline ? String(parsed.deadline) : null,
      confidence: typeof parsed.confidence === "number"
        ? Math.max(0, Math.min(1, parsed.confidence))
        : 0.5,
      domains: Array.isArray(parsed.domains)
        ? parsed.domains.map(String)
        : [],
    };
  } catch (err) {
    // JSON parse failed — fall back
    console.error("[mimir:extraction] JSON parse failed:", err, "Raw:", raw.slice(0, 300));
    return fallbackExtraction(originalText);
  }
}

/**
 * Extract entities, relationships, and metadata from text using an LLM.
 * Falls back to regex-based extraction when ANTHROPIC_API_KEY is not set.
 */
/**
 * Attempt to load ANTHROPIC_API_KEY from process.env, falling back to
 * reading .env directly if the MCP spawn didn't inherit it.
 */
function getAnthropicKey(): string | undefined {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;

  // Fallback: read .env directly (MCP server spawn may not inherit env)
  // Try local .env first (standalone repo), then parent .env (nested in gobot)
  const path = require("path");
  const fs = require("fs");
  const candidates = [
    path.resolve(__dirname, "../.env"),    // brain-mcp-server/.env (standalone)
    path.resolve(__dirname, "../../.env"), // gobot/.env (nested)
  ];

  for (const envPath of candidates) {
    try {
      const envContent = fs.readFileSync(envPath, "utf-8");
      const match = envContent.match(/^ANTHROPIC_API_KEY=(.+)$/m);
      if (match) {
        const key = match[1].trim().replace(/^["']|["']$/g, "");
        process.env.ANTHROPIC_API_KEY = key; // Cache for future calls
        console.error(`[mimir:extraction] Loaded ANTHROPIC_API_KEY from ${envPath}`);
        return key;
      }
    } catch {
      // This candidate doesn't exist — try next
    }
  }
  return undefined;
}

export async function extractFromText(
  text: string,
): Promise<ExtractionResult & { queued?: boolean }> {
  // Allow tests to force the deferred path
  if (process.env.BRAIN_DISABLE_LLM === "true") {
    console.error("[mimir:extraction] BRAIN_DISABLE_LLM=true — deferring extraction");
    return deferredExtraction();
  }

  const apiKey = getAnthropicKey();

  if (!apiKey) {
    console.error("[mimir:extraction] No ANTHROPIC_API_KEY — deferring extraction (queue pattern)");
    return deferredExtraction();
  }
  console.error(`[mimir:extraction] Using LLM model: ${process.env.MIMIR_EXTRACTION_MODEL ?? DEFAULT_MODEL}`);

  const model =
    process.env.MIMIR_EXTRACTION_MODEL ?? DEFAULT_MODEL;

  try {
    const client = new Anthropic({ apiKey });

    // Fetch existing entity context so the LLM can decide ADD vs UPDATE
    const existingContext = await getExistingEntityContext(text);
    const contextBlock = Object.keys(existingContext).length > 0
      ? `\n\nEXISTING ENTITIES (use for ADD/UPDATE/INVALIDATE decisions):\n${
          Object.entries(existingContext)
            .map(([name, summary]) => `- ${name}: ${summary}`)
            .join("\n")
        }`
      : "";

    const response = await client.messages.create({
      model,
      max_tokens: 2048,
      system: EXTRACTION_PROMPT,
      messages: [{ role: "user", content: text + contextBlock }],
    });

    // Extract text from the response
    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      return fallbackExtraction(text);
    }

    console.error("[mimir:extraction] Raw LLM response:", textBlock.text.slice(0, 500));
    return parseExtractionResponse(textBlock.text, text);
  } catch (err) {
    // API error — defer extraction to queue rather than producing garbage entities
    console.error("[mimir:extraction] LLM extraction failed, deferring to queue:", err);
    return deferredExtraction();
  }
}
