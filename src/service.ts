#!/usr/bin/env bun
/**
 * Mimir Service — Persistent Gatekeeper
 *
 * Long-running service that owns the FalkorDB lock and serves all clients:
 * - HTTP REST API on localhost:4200 (for GoBot, Observatory, scripts)
 * - MCP stdio on demand (for Claude Code, when spawned directly)
 *
 * This is the production entry point. Runs under launchd at boot.
 *
 * Usage: bun run src/service.ts
 */

import { initGraph, closeGraph, getGraph, findEntityByName, vectorSearch, hydrateNode } from "./graph.js";
import { retain } from "./verbs/retain.js";
import { recall } from "./verbs/recall.js";
import { pulse } from "./verbs/pulse.js";
import { reflect } from "./verbs/reflect.js";
import { connect } from "./verbs/connect.js";
import { anchor } from "./verbs/anchor.js";
import { triage } from "./verbs/triage.js";
import { processQueue } from "./verbs/process-queue.js";
import { forget } from "./verbs/forget.js";

const DATA_PATH =
  process.env.MIMIR_DATA_PATH || "/Volumes/AI-Lab/falkordb-data/personal-brain";
const PORT = parseInt(process.env.MIMIR_PORT || "4200", 10);

// Bearer-token auth gate. The graph holds personal knowledge; once the
// service is exposed via Cloudflare Tunnel the URL is reachable from the
// public internet, and an unauthenticated POST /api/retain or GET /api/recall
// would be a complete confidentiality + integrity breach. Required when
// MIMIR_REQUIRE_AUTH=true (default true on iOS pre-flight); the only path
// that stays open is /health, which leaks only "service is up" semantics.
//
// Comparison must be constant-time to defeat timing attacks. Bun ships
// crypto.timingSafeEqual via the standard node:crypto interop.
import { timingSafeEqual } from "node:crypto";

const REQUIRE_AUTH = (process.env.MIMIR_REQUIRE_AUTH ?? "true").toLowerCase() !== "false";
const SHARED_SECRET = process.env.MIMIR_SHARED_SECRET ?? "";
if (REQUIRE_AUTH && !SHARED_SECRET) {
  console.error(
    "[mimir] MIMIR_REQUIRE_AUTH is true but MIMIR_SHARED_SECRET is empty. " +
    "All non-/health requests will be rejected. " +
    "Set MIMIR_SHARED_SECRET in the launchd plist or unset MIMIR_REQUIRE_AUTH for local-only deployments.",
  );
}

function constantTimeEqual(a: string, b: string): boolean {
  // timingSafeEqual requires equal-length buffers; pad/truncate to avoid an
  // early-return length leak. Compare a fixed 64-byte slot regardless of
  // the actual secret length.
  const slot = 64;
  const ab = Buffer.alloc(slot);
  const bb = Buffer.alloc(slot);
  Buffer.from(a, "utf8").copy(ab, 0, 0, Math.min(a.length, slot));
  Buffer.from(b, "utf8").copy(bb, 0, 0, Math.min(b.length, slot));
  return timingSafeEqual(ab, bb) && a.length === b.length;
}

/** Returns a 401 Response when auth fails, or null when the request is allowed through. */
function requireBearer(req: Request, path: string): Response | null {
  if (!REQUIRE_AUTH) return null;
  if (path === "/health") return null; // Health is intentionally open.
  if (!SHARED_SECRET) {
    return jsonResponse({ error: "Service misconfigured: shared secret not set" }, 503);
  }
  const header = req.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return jsonResponse({ error: "Missing Authorization: Bearer <token>" }, 401);
  }
  if (!constantTimeEqual(match[1], SHARED_SECRET)) {
    return jsonResponse({ error: "Invalid bearer token" }, 401);
  }
  return null;
}

// ─── HTTP Server ───────────────────────────────────────────

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errorResponse(message: string, status = 400): Response {
  return jsonResponse({ error: message }, status);
}

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  // Auth gate — runs BEFORE any endpoint matching so a missing/wrong token
  // can't reveal endpoint existence by 400-vs-401-vs-405 responses.
  const denied = requireBearer(req, path);
  if (denied) return denied;

  // Health check
  if (path === "/health") {
    return jsonResponse({ status: "ok", graph: "mimir", uptime: process.uptime() });
  }

  // ── Recall (GET /api/recall?q=...&scope=...&from=...&to=...&as_of=...&intent=...) ──
  if (path === "/api/recall" && req.method === "GET") {
    const query = url.searchParams.get("q");
    if (!query) return errorResponse("Missing ?q= parameter");
    const scope = url.searchParams.get("scope") || undefined;
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    const asOfRaw = url.searchParams.get("as_of");
    const intentRaw = url.searchParams.get("intent");
    const timeRange = from || to
      ? { from: from ? parseInt(from) : undefined, to: to ? parseInt(to) : undefined }
      : undefined;
    const asOf = asOfRaw ? parseInt(asOfRaw) : undefined;
    const validIntents = new Set(["when", "who", "why", "what", "how"]);
    const intent = intentRaw && validIntents.has(intentRaw) ? intentRaw as any : undefined;
    const result = await recall(query, scope, timeRange, asOf, intent);
    return jsonResponse(result);
  }

  // ── Retain (POST /api/retain) ──
  if (path === "/api/retain" && req.method === "POST") {
    const body = await req.json();
    if (!body.content) return errorResponse("Missing content field");
    // event_at: accept ISO 8601 string or Unix ms integer
    let eventAt: number | undefined;
    if (body.event_at !== undefined) {
      eventAt = typeof body.event_at === "string"
        ? new Date(body.event_at).getTime()
        : body.event_at;
    }
    const result = await retain(body.content, body.source || "manual", body.participants || [], eventAt);
    return jsonResponse(result);
  }

  // ── Pulse (GET /api/pulse?entity=...) ──
  if (path === "/api/pulse" && req.method === "GET") {
    const entity = url.searchParams.get("entity");
    if (!entity) return errorResponse("Missing ?entity= parameter");
    const result = await pulse(entity);
    return jsonResponse(result);
  }

  // ── Reflect (GET /api/reflect?scope=...&from=...&to=...) ──
  if (path === "/api/reflect" && req.method === "GET") {
    const scope = url.searchParams.get("scope") || undefined;
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    const timeRange = from || to
      ? { from: from ? parseInt(from) : undefined, to: to ? parseInt(to) : undefined }
      : undefined;
    const result = await reflect(scope, timeRange);
    return jsonResponse(result);
  }

  // ── Connect (POST /api/connect) ──
  if (path === "/api/connect" && req.method === "POST") {
    const body = await req.json();
    if (!body.source || !body.target) return errorResponse("Missing source or target");
    const result = await connect(body.source, body.target, body.rationale, body.edge_type);
    return jsonResponse(result);
  }

  // ── Anchor (POST /api/anchor) ──
  if (path === "/api/anchor" && req.method === "POST") {
    const body = await req.json();
    if (!body.content || !body.domain) return errorResponse("Missing content or domain");
    const result = await anchor(body.content, body.domain, body.weight);
    return jsonResponse(result);
  }

  // ── Triage (POST /api/triage) ──
  if (path === "/api/triage" && req.method === "POST") {
    const body = await req.json();
    if (!body.content || !body.source) return errorResponse("Missing content or source");
    const result = await triage(body.content, body.source, body.source_type);
    return jsonResponse(result);
  }

  // ── Process Queue (POST /api/process-queue) ──
  if (path === "/api/process-queue" && req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    const result = await processQueue(body.limit || 20);
    return jsonResponse(result);
  }

  // ── Forget (POST /api/forget) ──
  // Retract knowledge about an entity or episode. Marks entity summaries as
  // [RETRACTED] and sets all derived fact edges to belief_state='retracted'.
  // Source Episodes and Thoughts are preserved as immutable ground truth.
  if (path === "/api/forget" && req.method === "POST") {
    const body = await req.json();
    if (!body.entity && !body.episode_id) {
      return errorResponse("Missing 'entity' (name) or 'episode_id'");
    }
    const result = await forget(body.entity || null, body.reason, body.episode_id);
    return jsonResponse(result);
  }

  // ── Context (GET /api/context?q=...&as_of=...) ──
  // Endpoint for GoBot prompt injection — returns formatted text with full
  // source material. Implements "Recursive Hydration": when a Thought or
  // Entity matches, follow edges to the source Episode and return its full
  // content. This prevents the "breadcrumb without the loaf" problem where
  // Claude sees truncated fragments and fills in the gaps with hallucinations.
  //
  // Phase 5 additions:
  // - Filters invalidated/retracted entity summaries (belief_state cleanup)
  // - Adds confirmed/asserted fact edge section (structured knowledge)
  // - Supports optional as_of temporal filtering
  if (path === "/api/context" && req.method === "GET") {
    const query = url.searchParams.get("q");
    if (!query) return errorResponse("Missing ?q= parameter");

    const asOfRaw = url.searchParams.get("as_of");
    const asOf = asOfRaw ? parseInt(asOfRaw) : undefined;

    const g = getGraph();
    const MAX_EPISODE_CHARS = 2000; // Full episode content, capped for prompt budget
    const seenEpisodes = new Set<string>(); // Dedupe by episode content prefix

    // ── Phase 1: Find Thoughts matching query, hydrate to source Episodes ──
    // as_of: filter Episodes by event_at so we only see content from before the cutoff.
    const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
    const thoughtSections: string[] = [];
    for (const word of words.slice(0, 3)) {
      // as_of filters Thought by ingestion time (created_at), matching recall.ts semantics
      const asOfFilter = asOf !== undefined ? " AND t.created_at <= $asOf" : "";
      const asOfParams = asOf !== undefined ? { q: word, asOf } : { q: word };
      const r = await g.query(
        `MATCH (t:Thought)
         WHERE toLower(t.content) CONTAINS toLower($q)${asOfFilter}
         OPTIONAL MATCH (t)-[:extracted_from]->(ep:Episode)
         RETURN t.content AS thought, t.created_at AS ts,
                ep.content AS episode, ep.source_type AS source
         ORDER BY t.created_at DESC LIMIT 3`,
        { params: asOfParams },
      );
      if (r.data) {
        for (const row of r.data as Record<string, unknown>[]) {
          const episode = row.episode as string | null;
          const thought = row.thought as string;
          const d = new Date(row.ts as number).toLocaleDateString();
          const source = row.source as string || "conversation";

          // Prefer full episode; fall back to thought content
          if (episode) {
            const key = episode.slice(0, 80);
            if (seenEpisodes.has(key)) continue;
            seenEpisodes.add(key);
            const content = episode.length > MAX_EPISODE_CHARS
              ? episode.slice(0, MAX_EPISODE_CHARS) + "… [truncated]"
              : episode;
            thoughtSections.push(`- [${d}] [SOURCE: ${source}]\n${content}`);
          } else {
            const key = thought.slice(0, 80);
            if (seenEpisodes.has(key)) continue;
            seenEpisodes.add(key);
            thoughtSections.push(`- [${d}] ${thought}`);
          }
        }
      }
    }

    // ── Phase 2: Find Entities, hydrate via hydrateNode() ──
    // Phase 5: skip entities whose summary starts with [INVALIDATED] or [RETRACTED]
    const entitySections: string[] = [];
    const seenEntityNames = new Set<string>();
    for (const word of words.slice(0, 5)) {
      const r = await g.query(
        `MATCH (e:Entity)
         WHERE toLower(e.name) CONTAINS toLower($w)
           AND NOT e.summary STARTS WITH '[INVALIDATED]'
           AND NOT e.summary STARTS WITH '[RETRACTED]'
         RETURN e.id AS id, e.name AS name, e.type AS type, e.summary AS summary
         LIMIT 3`,
        { params: { w: word } },
      );
      if (r.data) {
        for (const row of r.data as Record<string, unknown>[]) {
          const name = row.name as string;
          const id = row.id as string;
          if (seenEntityNames.has(name)) continue;
          seenEntityNames.add(name);

          // Hydrate: fetch source episode for this entity
          const hydrated = await hydrateNode(id, "Entity");
          if (hydrated && !seenEpisodes.has(hydrated.content.slice(0, 80))) {
            seenEpisodes.add(hydrated.content.slice(0, 80));
            const content = hydrated.content.length > MAX_EPISODE_CHARS
              ? hydrated.content.slice(0, MAX_EPISODE_CHARS) + "… [truncated]"
              : hydrated.content;
            entitySections.push(
              `- **${name}** (${row.type}): [SOURCE: ${hydrated.source_type}]\n${content}`,
            );
          } else {
            // No episode linked — show the entity summary as-is
            const summary = row.summary as string;
            entitySections.push(
              `- **${name}** (${row.type}): ${summary || "[no source material]"}`,
            );
          }
        }
      }
    }

    // ── Phase 2b: Confirmed/asserted fact edges related to query entities ──
    // Phase 5: inject only active (valid_until IS NULL), non-weakened/retracted facts.
    // This gives Claude structured "Kyle works_at HOPE Center" type facts alongside
    // the episodic context — two complementary views of the same knowledge.
    const factSections: string[] = [];
    const entityNamesForFacts = [...seenEntityNames].slice(0, 5);
    if (entityNamesForFacts.length > 0) {
      for (const name of entityNamesForFacts) {
        const asOfFactFilter = asOf !== undefined
          ? " AND r.valid_from <= $asOf" : "";
        const factParams: Record<string, unknown> = { name };
        if (asOf !== undefined) factParams.asOf = asOf;

        const factResult = await g.query(
          `MATCH (a:Entity)-[r]->(b:Entity)
           WHERE (toLower(a.name) = toLower($name) OR toLower(b.name) = toLower($name))
             AND r.valid_until IS NULL
             AND r.fact IS NOT NULL
             AND r.belief_state IN ['confirmed', 'asserted']${asOfFactFilter}
           RETURN a.name AS from_name, b.name AS to_name, r.fact AS fact,
                  r.belief_state AS state, r.source_authority AS authority
           ORDER BY r.source_authority DESC LIMIT 3`,
          { params: factParams },
        );
        if (factResult.data) {
          for (const row of factResult.data as Record<string, unknown>[]) {
            const state = row.state as string;
            const stateTag = state === "confirmed" ? " [✓]" : "";
            factSections.push(`  • ${row.from_name} → ${row.to_name}: ${row.fact}${stateTag}`);
          }
        }
      }
    }

    // ── Phase 3: Active anchors ──
    const anchorsResult = await g.query(
      `MATCH (a:Anchor) WHERE a.weight > 0 RETURN a.content AS c, a.domain AS d LIMIT 5`,
    );

    // ── Build output ──
    const out: string[] = [];
    if (thoughtSections.length > 0) {
      out.push(`**Related knowledge (full source):**\n${thoughtSections.slice(0, 5).join("\n\n")}`);
    }
    if (entitySections.length > 0) {
      out.push(`**Known entities (with source material):**\n${entitySections.join("\n\n")}`);
    }
    if (factSections.length > 0) {
      out.push(`**Confirmed facts:**\n${factSections.join("\n")}`);
    }
    if (anchorsResult.data && anchorsResult.data.length > 0) {
      out.push(
        `**Active anchors:**\n${(anchorsResult.data as Record<string, unknown>[])
          .map((r) => `- [${r.d}] ${r.c}`)
          .join("\n")}`,
      );
    }
    if (asOf !== undefined) {
      out.push(`_[Context filtered: as_of ${new Date(asOf).toLocaleDateString()}]_`);
    }

    return new Response(out.join("\n\n") || "", {
      headers: { "Content-Type": "text/plain" },
    });
  }

  // ── Queue status (GET /api/queue/status) ──
  // Monitor consolidation queue depth and worker configuration.
  if (path === "/api/queue/status" && req.method === "GET") {
    const g = getGraph();
    const result = await g.query(
      `MATCH (ep:Episode)
       WHERE ep.processed = false
       RETURN count(ep) AS pending, min(ep.timestamp) AS oldest_pending_at`,
    );
    const row = ((result.data?.[0]) as Record<string, unknown>) || {};
    return jsonResponse({
      pending: row.pending ?? 0,
      oldest_pending_at: row.oldest_pending_at ?? null,
      consolidation_interval_ms: parseInt(process.env.MIMIR_CONSOLIDATION_INTERVAL || "30000", 10),
      consolidation_batch_size: parseInt(process.env.MIMIR_CONSOLIDATION_BATCH || "10", 10),
      fast_retain: process.env.MIMIR_FAST_RETAIN === "true",
    });
  }

  // ── Entities for triage (GET /api/entities) ──
  if (path === "/api/entities" && req.method === "GET") {
    const g = getGraph();
    const r = await g.query(
      `MATCH (e:Entity)
       WHERE e.type IN ['person', 'org', 'project']
       RETURN e.name AS name, e.type AS type
       ORDER BY e.type, e.name
       LIMIT 50`,
    );
    if (!r.data || r.data.length === 0) {
      return new Response("", { headers: { "Content-Type": "text/plain" } });
    }
    const text = (r.data as Record<string, unknown>[])
      .map((row) => `- ${row.name} (${row.type})`)
      .join("\n");
    return new Response(text, { headers: { "Content-Type": "text/plain" } });
  }

  return errorResponse("Not found", 404);
}

// ─── Startup ───────────────────────────────────────────────

async function main() {
  console.log("[mimir] Starting Mimir service...");
  console.log(`[mimir] Data path: ${DATA_PATH}`);
  console.log(`[mimir] HTTP port: ${PORT}`);

  await initGraph(DATA_PATH);
  console.log("[mimir] FalkorDB graph initialized (lock acquired)");

  const server = Bun.serve({
    port: PORT,
    fetch: async (req) => {
      try {
        return await handleRequest(req);
      } catch (err: any) {
        console.error("[mimir] Request error:", err);
        return errorResponse(err.message || "Internal server error", 500);
      }
    },
  });

  console.log(`[mimir] HTTP server listening on http://localhost:${PORT}`);
  console.log("[mimir] Endpoints:");
  console.log("  GET  /health");
  console.log("  GET  /api/queue/status");
  console.log("  GET  /api/context?q=...");
  console.log("  GET  /api/recall?q=...&as_of=...&intent=...");
  console.log("  GET  /api/pulse?entity=...");
  console.log("  GET  /api/reflect");
  console.log("  GET  /api/entities");
  console.log("  POST /api/retain  (event_at supported)");
  console.log("  POST /api/connect");
  console.log("  POST /api/anchor");
  console.log("  POST /api/triage");
  console.log("  POST /api/process-queue");

  // ── Consolidation worker (dual-stream slow path) ────────────────────────
  // Automatically processes Episodes deferred by retain() in MIMIR_FAST_RETAIN
  // mode, or any that failed extraction on first attempt. Runs on a configurable
  // interval. Never blocks the retain() fast path.
  const CONSOLIDATION_INTERVAL_MS = parseInt(
    process.env.MIMIR_CONSOLIDATION_INTERVAL || "30000", 10
  );
  const CONSOLIDATION_BATCH_SIZE = parseInt(
    process.env.MIMIR_CONSOLIDATION_BATCH || "10", 10
  );

  async function runConsolidation() {
    try {
      const result = await processQueue(CONSOLIDATION_BATCH_SIZE);
      if (result.processed > 0 || result.failed > 0) {
        console.log(
          `[consolidation] processed=${result.processed} failed=${result.failed} skipped=${result.skipped}`,
        );
      }
    } catch (err: any) {
      console.error("[consolidation] Worker error:", err.message);
    }
  }

  // Initial pass 5 seconds after startup (catches any deferred Episodes from before restart)
  setTimeout(runConsolidation, 5_000);
  // Recurring pass
  setInterval(runConsolidation, CONSOLIDATION_INTERVAL_MS);

  const fastMode = process.env.MIMIR_FAST_RETAIN === "true";
  console.log(
    `[mimir] Consolidation worker: interval=${CONSOLIDATION_INTERVAL_MS}ms batch=${CONSOLIDATION_BATCH_SIZE} fast_retain=${fastMode}`,
  );

  // Graceful shutdown
  const shutdown = async () => {
    console.log("[mimir] Shutting down...");
    server.stop();
    await closeGraph();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[mimir] Fatal error:", err);
  process.exit(1);
});
