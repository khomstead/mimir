/**
 * Mimir — LLM-Powered Anchor Tension Evaluation
 *
 * When new content arrives in a domain with active Anchors, this module
 * evaluates whether the content aligns with, extends, or tensions with
 * each Anchor. Uses a Sonnet-class model for nuanced evaluation.
 */

import Anthropic from "@anthropic-ai/sdk";
import { recordMimirCost } from "./cost-tracking.js";

const EVAL_MODEL = process.env.MIMIR_TENSION_MODEL || "claude-sonnet-4-5-20250514";

const TENSION_PROMPT = `You evaluate whether new content aligns with or tensions against a philosophical anchor (a deeply held principle).

Given an ANCHOR (a guiding principle) and NEW CONTENT (something recently captured), determine:

1. **alignment**: Does the new content align with the anchor? ("aligned", "extends", "neutral", "tensions", "contradicts")
2. **tension_description**: If there is tension, explain it in 1-2 sentences. Be specific about what conflicts. If aligned, say why.
3. **severity**: How serious is the tension? (0.0 = perfectly aligned, 1.0 = direct contradiction)

Return ONLY valid JSON (no markdown fences):
{
  "alignment": "aligned|extends|neutral|tensions|contradicts",
  "tension_description": "explanation",
  "severity": 0.0
}`;

export interface TensionEvaluation {
  alignment: "aligned" | "extends" | "neutral" | "tensions" | "contradicts";
  tension_description: string;
  severity: number;
}

/**
 * Evaluate whether content tensions with an anchor.
 * Returns null if LLM is unavailable (non-fatal).
 */
export async function evaluateTension(
  anchorContent: string,
  newContent: string,
): Promise<TensionEvaluation | null> {
  if (process.env.BRAIN_DISABLE_LLM === "true") return null;

  // Try to get API key
  let apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    try {
      const path = require("path");
      const fs = require("fs");
      const candidates = [
        path.resolve(__dirname, "../.env"),
        path.resolve(__dirname, "../../.env"),
      ];
      for (const envPath of candidates) {
        try {
          const envContent = fs.readFileSync(envPath, "utf-8");
          const match = envContent.match(/^ANTHROPIC_API_KEY=(.+)$/m);
          if (match) {
            apiKey = match[1].trim().replace(/^["']|["']$/g, "");
            break;
          }
        } catch {}
      }
    } catch {}
  }

  if (!apiKey) return null;

  try {
    const client = new Anthropic({ apiKey });
    const tensionStartedAt = Date.now();
    const response = await client.messages.create({
      model: EVAL_MODEL,
      max_tokens: 256,
      system: TENSION_PROMPT,
      messages: [
        {
          role: "user",
          content: `ANCHOR: ${anchorContent}\n\nNEW CONTENT: ${newContent}`,
        },
      ],
    });

    recordMimirCost({
      operation: "mimir_tension",
      model: EVAL_MODEL,
      usage: response.usage,
      durationMs: Date.now() - tensionStartedAt,
      requestId: response.id,
    });

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") return null;

    let cleaned = textBlock.text.trim();
    if (cleaned.startsWith("```")) {
      cleaned = cleaned.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    }

    const parsed = JSON.parse(cleaned);

    const validAlignments = new Set(["aligned", "extends", "neutral", "tensions", "contradicts"]);
    return {
      alignment: validAlignments.has(parsed.alignment) ? parsed.alignment : "neutral",
      tension_description: String(parsed.tension_description || ""),
      severity: typeof parsed.severity === "number"
        ? Math.max(0, Math.min(1, parsed.severity))
        : 0,
    };
  } catch (err) {
    console.error("[mimir:tension-eval] Evaluation failed:", err);
    return null;
  }
}
