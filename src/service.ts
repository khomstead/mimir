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

const DATA_PATH =
  process.env.MIMIR_DATA_PATH || "/Volumes/AI-Lab/falkordb-data/personal-brain";
const PORT = parseInt(process.env.MIMIR_PORT || "4200", 10);

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

  // Health check
  if (path === "/health") {
    return jsonResponse({ status: "ok", graph: "mimir", uptime: process.uptime() });
  }

  // ── Recall (GET /api/recall?q=...&scope=...&from=...&to=...) ──
  if (path === "/api/recall" && req.method === "GET") {
    const query = url.searchParams.get("q");
    if (!query) return errorResponse("Missing ?q= parameter");
    const scope = url.searchParams.get("scope") || undefined;
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    const timeRange = from || to
      ? { from: from ? parseInt(from) : undefined, to: to ? parseInt(to) : undefined }
      : undefined;
    const result = await recall(query, scope, timeRange);
    return jsonResponse(result);
  }

  // ── Retain (POST /api/retain) ──
  if (path === "/api/retain" && req.method === "POST") {
    const body = await req.json();
    if (!body.content) return errorResponse("Missing content field");
    const result = await retain(body.content, body.source || "manual", body.participants || []);
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

  // ── Context (GET /api/context?q=...) ──
  // Endpoint for GoBot prompt injection — returns formatted text with full
  // source material. Implements "Recursive Hydration": when a Thought or
  // Entity matches, follow edges to the source Episode and return its full
  // content. This prevents the "breadcrumb without the loaf" problem where
  // Claude sees truncated fragments and fills in the gaps with hallucinations.
  if (path === "/api/context" && req.method === "GET") {
    const query = url.searchParams.get("q");
    if (!query) return errorResponse("Missing ?q= parameter");

    const g = getGraph();
    const MAX_EPISODE_CHARS = 2000; // Full episode content, capped for prompt budget
    const seenEpisodes = new Set<string>(); // Dedupe by episode content prefix

    // ── Phase 1: Find Thoughts matching query, hydrate to source Episodes ──
    const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
    const thoughtSections: string[] = [];
    for (const word of words.slice(0, 3)) {
      const r = await g.query(
        `MATCH (t:Thought)
         WHERE toLower(t.content) CONTAINS toLower($q)
         OPTIONAL MATCH (t)-[:extracted_from]->(ep:Episode)
         RETURN t.content AS thought, t.created_at AS ts,
                ep.content AS episode, ep.source_type AS source
         ORDER BY t.created_at DESC LIMIT 3`,
        { params: { q: word } },
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
    const entitySections: string[] = [];
    const seenEntityNames = new Set<string>();
    for (const word of words.slice(0, 5)) {
      const r = await g.query(
        `MATCH (e:Entity)
         WHERE toLower(e.name) CONTAINS toLower($w)
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

    // ── Phase 3: Active anchors (unchanged) ──
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
    if (anchorsResult.data && anchorsResult.data.length > 0) {
      out.push(
        `**Active anchors:**\n${(anchorsResult.data as Record<string, unknown>[])
          .map((r) => `- [${r.d}] ${r.c}`)
          .join("\n")}`,
      );
    }

    return new Response(out.join("\n\n") || "", {
      headers: { "Content-Type": "text/plain" },
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
  console.log("  GET  /api/context?q=...");
  console.log("  GET  /api/recall?q=...");
  console.log("  GET  /api/pulse?entity=...");
  console.log("  GET  /api/reflect");
  console.log("  GET  /api/entities");
  console.log("  POST /api/retain");
  console.log("  POST /api/connect");
  console.log("  POST /api/anchor");
  console.log("  POST /api/triage");
  console.log("  POST /api/process-queue");

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
