/**
 * Mimir Cost Tracking — lightweight client that posts to the gobot Convex
 * mutation `mosscapCosts.record` so Mimir's LLM usage shows up alongside
 * gobot's in the Observatory cost dashboard.
 *
 * Fire-and-forget. Never throws. Never blocks the caller.
 */

const CONVEX_URL =
  process.env.CONVEX_URL || process.env.MIMIR_CONVEX_URL || "";

interface TokenUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

interface CostEntry {
  operation: string;
  model: string;
  usage: TokenUsage;
  durationMs: number;
  requestId?: string;
}

// Per-million-token pricing (USD). Mirrors gobot/src/lib/cost-tracking.ts.
const PRICING: Record<string, { input: number; output: number; cacheRead?: number }> = {
  "claude-haiku-4-5-20251001": { input: 0.8, output: 4, cacheRead: 0.08 },
  "claude-haiku-4-5": { input: 0.8, output: 4, cacheRead: 0.08 },
  "claude-sonnet-4-5-20250929": { input: 3, output: 15, cacheRead: 0.3 },
  "claude-sonnet-4-5": { input: 3, output: 15, cacheRead: 0.3 },
};

function estimate(model: string, usage: TokenUsage): number {
  const p = PRICING[model] ?? PRICING[model.replace(/-\d{8}$/, "")];
  if (!p) return 0;
  const i = usage.input_tokens ?? 0;
  const o = usage.output_tokens ?? 0;
  const cr = usage.cache_read_input_tokens ?? 0;
  return (
    ((i / 1e6) * p.input +
      (o / 1e6) * p.output +
      (cr / 1e6) * (p.cacheRead ?? 0))
  );
}

/**
 * Post a cost event to the gobot Convex deployment. Best-effort — any
 * network failure is swallowed. Uses the same deployment URL gobot does.
 */
export function recordMimirCost(entry: CostEntry): void {
  if (!CONVEX_URL) return;
  const usd = estimate(entry.model, entry.usage);

  // Convex HTTP mutation endpoint format:
  //   POST <CONVEX_URL>/api/mutation { "path": "mosscapCosts:record", "args": {...} }
  // The url is https://<deployment>.convex.cloud
  const httpUrl = CONVEX_URL.replace(/\.convex\.cloud$/, ".convex.site");
  const apiBase = httpUrl.includes(".convex.site")
    ? CONVEX_URL.replace(".convex.site", ".convex.cloud")
    : CONVEX_URL;

  // Use ConvexHttpClient via REST — but Mimir doesn't have it installed.
  // Fall back to the public HTTP mutation endpoint.
  fetch(`${apiBase}/api/mutation`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      path: "mosscapCosts:record",
      args: {
        provider: "anthropic",
        operation: entry.operation,
        channel: "background",
        sourceProject: "mimir",
        requestId: entry.requestId,
        inputTokens: entry.usage.input_tokens ?? undefined,
        outputTokens: entry.usage.output_tokens ?? undefined,
        cacheReadTokens: entry.usage.cache_read_input_tokens ?? undefined,
        cacheCreationTokens:
          entry.usage.cache_creation_input_tokens ?? undefined,
        model: entry.model,
        estimatedCostUsd: Number.isFinite(usd) && usd >= 0 ? usd : 0,
        durationMs: entry.durationMs,
      },
      format: "json",
    }),
  }).catch(() => {
    // swallow — observability failure must not affect Mimir
  });
}
