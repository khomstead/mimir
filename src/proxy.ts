#!/usr/bin/env bun
/**
 * Mimir HTTP Proxy MCP Server
 *
 * Exposes all 8 Mimir verbs via MCP stdio, forwarding each call to the
 * Mimir HTTP service (default localhost:4200). Zero FalkorDB dependency —
 * no lock contention, startup in <100ms.
 *
 * This is the correct entry point for .mcp.json. The direct stdio server
 * (src/index.ts) opens FalkorDB and conflicts with the always-on HTTP
 * service (src/service.ts) which holds the exclusive database lock.
 *
 * Env:
 *   MIMIR_URL     — base URL of HTTP service (default: http://localhost:4200)
 *   MIMIR_SOURCE  — source label added to X-Mimir-Source header (default: claude-code)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const MIMIR_URL = process.env.MIMIR_URL || "http://localhost:4200";
const MIMIR_SOURCE = process.env.MIMIR_SOURCE || "claude-code";
const TIMEOUT_MS = 10_000;

const OFFLINE_MSG =
  "Mimir service is offline. Restart: launchctl load ~/Library/LaunchAgents/com.speki.mimir.plist";

// Mimir's HTTP service requires Bearer auth (MIMIR_REQUIRE_AUTH=true in the
// launchd plist). Pull the shared secret from env so the proxy can pass it
// through. Any caller that wants MCP-driven retain/recall must export this
// var (or set it in .mcp.json's `env` block) — without it the service
// returns 401.
const MIMIR_BEARER = process.env.MIMIR_SHARED_SECRET ?? "";

// ───────────────────────────────────────────────────────────────────────────
// Sprint A.1 + F-04 + Identity Session 2 — per-session tenant routing.
//
// The gobot daemon sets `MOSSCAP_ACTOR_USER_ID` on the Claude Code
// subprocess env before spawning. This stdio proxy inherits that env from
// its parent (Claude Code), so we can read it on every tool call and pass
// it through as `X-Mimir-User-Id` to the Mimir HTTP service. Mimir's
// Phase 1E tenant gate validates the header.
//
// Two env names checked in priority order — there is deliberately NO
// default-user fallback (Identity Session 2, 2026-07-02: GOBOT_DEFAULT_USER_ID
// tier removed). When neither is set, the proxy sends NO X-Mimir-User-Id
// header and the service tenant gate 401s: an unattributed call fails
// closed instead of being silently mis-stamped into the default tenant.
//   1. MOSSCAP_ACTOR_USER_ID  — set per turn by the daemon (Sprint A.1)
//   2. MIMIR_USER_ID          — deliberate single-user assertion (interactive)
//
// Telemetry: every request carries `X-Mimir-Id-Source: actor|explicit|none`
// and the resolved tier is logged to stderr, so a fallback regression is
// visible in both service request logs and MCP proxy logs.
//
// Privacy clause 13 (proposal v2.2 §11.5): "X-Mimir-User-Id MUST be set
// to the calling user's userId, sourced from mosscap_sessions.userId —
// never the daemon's identity." This proxy now honors that contract.
// ───────────────────────────────────────────────────────────────────────────

type CallerIdSource = "actor" | "explicit" | "none";

function resolveCallerIdentity(): { userId: string | undefined; source: CallerIdSource } {
  const actor = process.env.MOSSCAP_ACTOR_USER_ID;
  if (actor) return { userId: actor, source: "actor" };
  const explicit = process.env.MIMIR_USER_ID;
  if (explicit) return { userId: explicit, source: "explicit" };
  return { userId: undefined, source: "none" };
}

function applyIdentityHeaders(headers: Record<string, string>): void {
  const { userId, source } = resolveCallerIdentity();
  headers["X-Mimir-Id-Source"] = source;
  if (userId) {
    headers["X-Mimir-User-Id"] = userId;
    console.error(`[mimir-proxy] id-source=${source}`);
  } else {
    console.error(
      "[mimir-proxy] id-source=none — neither MOSSCAP_ACTOR_USER_ID nor MIMIR_USER_ID " +
        "is set; sending no X-Mimir-User-Id (service tenant gate will 401 fail-closed)",
    );
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Knowledge Architecture P1 (2026-06-03) — active-place forwarding.
//
// The gobot daemon sets these per-turn env vars on the Claude Code subprocess
// (alongside MOSSCAP_ACTOR_USER_ID), resolved from the caller's REAL
// memberships (mimir-tenant-builder). The proxy inherits the env and forwards
// them so the MCP recall path becomes place-aware — org canon surfaces +
// in-workspace results foreground, each provenance-labeled. The daemon is the
// trust boundary (it asserts only orgs/folios the user actually belongs to);
// the Mimir service trusts the bearer-authed daemon, same as folio-ids.
//
//   MOSSCAP_ACTIVE_ORG        → X-Mimir-Active-Org (Convex organizations _id)
//   MOSSCAP_ACTIVE_ORG_NAME   → X-Mimir-Active-Org-Name (for the canon label)
//   MOSSCAP_ACTIVE_FOLIO_IDS  → X-Mimir-Active-Folio-Ids (active workspace boost)
//   MOSSCAP_FOLIO_IDS         → X-Mimir-Folio-Ids (full accessible-folio list)
// ───────────────────────────────────────────────────────────────────────────
function applyPlaceHeaders(headers: Record<string, string>): void {
  const activeOrg = process.env.MOSSCAP_ACTIVE_ORG;
  if (activeOrg) headers["X-Mimir-Active-Org"] = activeOrg;
  const activeOrgName = process.env.MOSSCAP_ACTIVE_ORG_NAME;
  if (activeOrgName) headers["X-Mimir-Active-Org-Name"] = activeOrgName;
  const activeFolioIds = process.env.MOSSCAP_ACTIVE_FOLIO_IDS;
  if (activeFolioIds) headers["X-Mimir-Active-Folio-Ids"] = activeFolioIds;
  const folioIds = process.env.MOSSCAP_FOLIO_IDS;
  if (folioIds) headers["X-Mimir-Folio-Ids"] = folioIds;
}

function commonHeaders() {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Mimir-Source": MIMIR_SOURCE,
  };
  if (MIMIR_BEARER) {
    headers["Authorization"] = `Bearer ${MIMIR_BEARER}`;
  }
  applyIdentityHeaders(headers);
  applyPlaceHeaders(headers);
  return headers;
}

function readHeaders() {
  const headers: Record<string, string> = {
    "X-Mimir-Source": MIMIR_SOURCE,
  };
  if (MIMIR_BEARER) {
    headers["Authorization"] = `Bearer ${MIMIR_BEARER}`;
  }
  applyIdentityHeaders(headers);
  applyPlaceHeaders(headers);
  return headers;
}

async function httpGet(path: string, params: Record<string, string | number | undefined> = {}): Promise<unknown> {
  const url = new URL(MIMIR_URL + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url.toString(), {
      signal: ac.signal,
      headers: readHeaders(),
    });
    if (!res.ok) throw new Error(`Mimir HTTP ${res.status}: ${await res.text()}`);
    return await res.json();
  } catch (e: any) {
    if (e.name === "AbortError" || e.code === "ECONNREFUSED") throw new Error(OFFLINE_MSG);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function httpPost(path: string, body: unknown): Promise<unknown> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(MIMIR_URL + path, {
      method: "POST",
      headers: commonHeaders(),
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    if (!res.ok) throw new Error(`Mimir HTTP ${res.status}: ${await res.text()}`);
    return await res.json();
  } catch (e: any) {
    if (e.name === "AbortError" || e.code === "ECONNREFUSED") throw new Error(OFFLINE_MSG);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function ok(result: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
}
function fail(msg: string) {
  return { content: [{ type: "text" as const, text: msg }], isError: true as const };
}

const server = new McpServer({ name: "mimir-proxy", version: "0.1.0" });

// ── retain ──────────────────────────────────────────────────────────────────
server.tool(
  "retain",
  "Capture a thought, observation, conversation, or any input into Mimir. " +
    "The Intelligence Layer extracts entities, relationships, and connections automatically. " +
    "Returns what was stored, any entities found, connections to existing knowledge, " +
    "and action items detected (commitments, deadlines).",
  {
    content: z.string().describe(
      "The text to capture — a thought, observation, conversation excerpt, or note"
    ),
    source: z
      .enum(["chat", "voice", "email", "manual", "meeting"])
      .optional()
      .default("manual")
      .describe("Where this input came from"),
    participants: z
      .array(z.string())
      .optional()
      .default([])
      .describe("People involved in this conversation or observation"),
    event_at: z
      .string()
      .optional()
      .describe(
        "ISO 8601 datetime of when this event actually occurred (may differ from now). " +
        "Example: '2026-05-05T14:00:00' for an event that happened last Tuesday. " +
        "Omit to default to the current time (ingestion time = event time)."
      ),
  },
  async ({ content, source, participants, event_at }) => {
    try {
      return ok(await httpPost("/api/retain", { content, source, participants, event_at }));
    } catch (e: any) {
      return fail(`retain failed: ${e.message}`);
    }
  },
);

// ── recall ───────────────────────────────────────────────────────────────────
server.tool(
  "recall",
  "Search Mimir for relevant knowledge. Uses semantic search (vector similarity), " +
    "graph traversal (entity relationships), and anchor matching. " +
    "Returns ranked results with provenance and relationship context.",
  {
    query: z.string().describe("Natural language query — what are you looking for?"),
    scope: z.string().optional().describe("Limit search to a specific domain or project"),
    time_range_from: z
      .number()
      .optional()
      .describe("Only return results created after this Unix timestamp (ms)"),
    time_range_to: z
      .number()
      .optional()
      .describe("Only return results created before this Unix timestamp (ms)"),
    as_of: z
      .number()
      .optional()
      .describe(
        "Point-in-time query: only return knowledge that existed at this Unix timestamp (ms). " +
        "Lets you reconstruct what Mimir knew at a past moment. " +
        "Example: pass the start of March to get the March world-state."
      ),
    intent: z
      .enum(["when", "who", "why", "what", "how"])
      .optional()
      .describe(
        "Query intent hint — shapes retrieval strategy. " +
        "'when' → temporal Episode-first search sorted by event time; " +
        "'who' → entity/person-focused graph traversal; " +
        "'why' → causal relationship traversal; " +
        "'what'/'how' → default semantic + graph behavior."
      ),
  },
  async ({ query, scope, time_range_from, time_range_to, as_of, intent }) => {
    try {
      return ok(
        await httpGet("/api/recall", {
          q: query,
          scope,
          from: time_range_from,
          to: time_range_to,
          as_of,
          intent,
        }),
      );
    } catch (e: any) {
      return fail(`recall failed: ${e.message}`);
    }
  },
);

// ── pulse ─────────────────────────────────────────────────────────────────────
server.tool(
  "pulse",
  "Get a status synthesis for an entity or domain. " +
    "Returns recent thoughts, active anchors, open commitments, connections, " +
    "and unresolved tensions — a comprehensive view of the current state.",
  {
    entity_or_domain: z
      .string()
      .describe("Name of a person, project, concept, or domain to get the pulse of"),
  },
  async ({ entity_or_domain }) => {
    try {
      return ok(await httpGet("/api/pulse", { entity: entity_or_domain }));
    } catch (e: any) {
      return fail(`pulse failed: ${e.message}`);
    }
  },
);

// ── reflect ───────────────────────────────────────────────────────────────────
server.tool(
  "reflect",
  "Run distillation over recent thoughts. Detects patterns, evolving ideas, " +
    "domain gaps, and synthesizes across captured knowledge. " +
    "Can be scoped to a domain and time range.",
  {
    scope: z.string().optional().describe("Limit reflection to a specific domain or topic"),
    time_range_from: z
      .number()
      .optional()
      .describe("Start of period (Unix timestamp ms). Defaults to 7 days ago"),
    time_range_to: z
      .number()
      .optional()
      .describe("End of period (Unix timestamp ms). Defaults to now"),
  },
  async ({ scope, time_range_from, time_range_to }) => {
    try {
      return ok(
        await httpGet("/api/reflect", {
          scope,
          from: time_range_from,
          to: time_range_to,
        }),
      );
    } catch (e: any) {
      return fail(`reflect failed: ${e.message}`);
    }
  },
);

// ── connect ───────────────────────────────────────────────────────────────────
server.tool(
  "connect",
  "Create an explicit connection between two entities, thoughts, or anchors. " +
    "Use this when you see a relationship Mimir hasn't noticed on its own.",
  {
    source: z.string().describe("Name or ID of the source node"),
    target: z.string().describe("Name or ID of the target node"),
    rationale: z.string().optional().describe("Why this connection exists"),
    edge_type: z
      .enum([
        "relates_to", "constrains", "involves", "contributes_to",
        "tensions_with", "scoped_to", "demonstrates", "discussed_in",
        "progresses_from",
      ])
      .optional()
      .default("relates_to")
      .describe("Type of relationship"),
  },
  async ({ source, target, rationale, edge_type }) => {
    try {
      return ok(await httpPost("/api/connect", { source, target, rationale, edge_type }));
    } catch (e: any) {
      return fail(`connect failed: ${e.message}`);
    }
  },
);

// ── anchor ────────────────────────────────────────────────────────────────────
server.tool(
  "anchor",
  "Create a load-bearing philosophy (Anchor) that constrains downstream work in a domain. " +
    "Anchors are never silently superseded — old anchors get timestamps and supersedes edges. " +
    "Use sparingly for deeply held principles, not preferences.",
  {
    content: z.string().describe("The philosophical statement or guiding principle"),
    domain: z
      .string()
      .describe(
        "Which life/work domain this constrains (e.g., 'education', 'career', 'parenting')"
      ),
    weight: z
      .number()
      .optional()
      .default(1.0)
      .describe("Importance weight (0.0-1.0, default 1.0)"),
  },
  async ({ content, domain, weight }) => {
    try {
      return ok(await httpPost("/api/anchor", { content, domain, weight }));
    } catch (e: any) {
      return fail(`anchor failed: ${e.message}`);
    }
  },
);

// ── triage ────────────────────────────────────────────────────────────────────
server.tool(
  "triage",
  "Process an external signal (email, message, notification) through Mimir's " +
    "intelligence layer. Identifies related entities and anchors, assesses priority, " +
    "and routes the signal appropriately.",
  {
    content: z.string().describe("The signal content (email body, message text, etc.)"),
    source: z.string().describe("Source identifier (email address, sender name, channel name)"),
    source_type: z
      .enum(["email", "message", "notification", "calendar", "other"])
      .optional()
      .default("message")
      .describe("Type of external signal"),
  },
  async ({ content, source, source_type }) => {
    try {
      return ok(await httpPost("/api/triage", { content, source, source_type }));
    } catch (e: any) {
      return fail(`triage failed: ${e.message}`);
    }
  },
);

// ── forget ────────────────────────────────────────────────────────────────────
server.tool(
  "forget",
  "Retract knowledge about a named entity or specific episode. " +
    "Marks the entity summary as [RETRACTED] and invalidates all derived fact edges. " +
    "Source Episodes and Thoughts are preserved as immutable ground truth — " +
    "retraction only affects derived knowledge, not the original records.",
  {
    entity: z
      .string()
      .optional()
      .describe("Name of the entity to retract (e.g. 'Kyle', 'De la Luz Soundstage'). " +
        "Mutually exclusive with episode_id."),
    episode_id: z
      .string()
      .optional()
      .describe("UUID of the Episode whose derived facts should be retracted. " +
        "Mutually exclusive with entity."),
    reason: z
      .string()
      .optional()
      .describe("Human-readable reason for retraction (stored for audit trail)."),
  },
  async ({ entity, episode_id, reason }) => {
    try {
      return ok(await httpPost("/api/forget", { entity, episode_id, reason }));
    } catch (e: any) {
      return fail(`forget failed: ${e.message}`);
    }
  },
);

// ── process_queue ─────────────────────────────────────────────────────────────
server.tool(
  "process_queue",
  "Process deferred Episodes that were captured without LLM extraction. " +
    "Run this when the ANTHROPIC_API_KEY becomes available to backfill " +
    "entity extraction on queued content.",
  {
    limit: z
      .number()
      .optional()
      .default(20)
      .describe("Max episodes to process in one batch (default 20)"),
  },
  async ({ limit }) => {
    try {
      return ok(await httpPost("/api/process-queue", { limit }));
    } catch (e: any) {
      return fail(`process_queue failed: ${e.message}`);
    }
  },
);

// ── startup ───────────────────────────────────────────────────────────────────
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
