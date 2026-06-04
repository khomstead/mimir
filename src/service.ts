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

import { initGraph, closeGraph, getGraph, findEntityByName, vectorSearch, hydrateNode, applyTenantFilter } from "./graph.js";
import { retain } from "./verbs/retain.js";
import { recall } from "./verbs/recall.js";
import { pulse } from "./verbs/pulse.js";
import { reflect } from "./verbs/reflect.js";
import { connect } from "./verbs/connect.js";
import { anchor } from "./verbs/anchor.js";
import { triage } from "./verbs/triage.js";
import { processQueue } from "./verbs/process-queue.js";
import { forget, forgetByShareRevocation } from "./verbs/forget.js";
import { explainEpisode } from "./verbs/explain-episode.js";
import { generateEmbedding } from "./embeddings.js";
import type { TenantStamp, TenantFilter } from "./types.js";

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

// Phase 1E: tenant-header cutover gate.
// When true: missing X-Mimir-User-Id → 401 (fail-closed).
// When false (Phase 1E cutover window): missing header logs a warning and
// defaults to GOBOT_DEFAULT_USER_ID. Lets gobot+Mimir deploys land
// non-atomically (gobot ships header-passing → 24h verification → flip
// this env to true). Defaults to FALSE for backward-compat on the
// initial deploy; flip via launchd plist update.
const REQUIRE_TENANT_HEADER =
  (process.env.MIMIR_REQUIRE_TENANT_HEADER ?? "false").toLowerCase() === "true";
const DEFAULT_TENANT_FALLBACK_USER_ID =
  process.env.GOBOT_DEFAULT_USER_ID ?? "";
if (!REQUIRE_TENANT_HEADER && !DEFAULT_TENANT_FALLBACK_USER_ID) {
  console.error(
    "[mimir] MIMIR_REQUIRE_TENANT_HEADER=false AND GOBOT_DEFAULT_USER_ID empty. " +
    "Tenant-stamped writes from clients lacking X-Mimir-User-Id will fail. " +
    "Set GOBOT_DEFAULT_USER_ID to Kyle's userId for the cutover window, " +
    "or flip MIMIR_REQUIRE_TENANT_HEADER=true once gobot ships header-passing.",
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

// ─── Phase 1E: Tenant header parsing ────────────────────────

/**
 * Parse Phase 1E tenant headers from a request.
 *
 *   X-Mimir-User-Id        Convex `users` _id of the caller (required)
 *   X-Mimir-Active-Org     Convex `organizations` _id (optional)
 *   X-Mimir-Folio-Ids      comma-separated `mosscap_folios` _ids (optional)
 *
 * Returns null if missing (caller path must decide whether to 401 or
 * fallback). Header parsing only — no validation against Convex; the
 * service trusts the gobot daemon (gated by Bearer auth) to send
 * legitimate IDs.
 */
function parseTenantHeaders(req: Request): {
  userId: string | null;
  activeOrgScope: string | undefined;
  folioIds: string[];
  // Knowledge Architecture P1 (2026-06-03):
  activeFolioIds: string[];          // active workspace (boost signal, subset of folioIds)
  activeOrgName: string | undefined; // for the "<Org> canon" provenance label
  orgCanon: boolean;                 // write-side: mark this retain as org canon
} {
  const userId = req.headers.get("x-mimir-user-id") || null;
  const activeOrgScope = req.headers.get("x-mimir-active-org") || undefined;
  const folioHeader = req.headers.get("x-mimir-folio-ids") || "";
  const folioIds = folioHeader
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const activeFolioHeader = req.headers.get("x-mimir-active-folio-ids") || "";
  const activeFolioIds = activeFolioHeader
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const activeOrgName = req.headers.get("x-mimir-active-org-name") || undefined;
  const orgCanon =
    (req.headers.get("x-mimir-org-canon") || "").toLowerCase() === "true";
  return { userId, activeOrgScope, folioIds, activeFolioIds, activeOrgName, orgCanon };
}

/**
 * Phase 1E: extract a TenantStamp for write paths (retain, anchor, etc.).
 * Returns a 401 Response if no userId is present AND the require gate is on.
 * Returns the TenantStamp if either the header is present, or the
 * fallback is enabled and a default userId exists.
 */
function extractTenantStamp(req: Request): { stamp: TenantStamp } | { denied: Response } {
  const { userId, activeOrgScope, folioIds, orgCanon } = parseTenantHeaders(req);

  if (userId) {
    return {
      stamp: {
        userId,
        organizationId: activeOrgScope,
        folioIds: folioIds.length > 0 ? folioIds : undefined,
        orgCanon: orgCanon || undefined,
      },
    };
  }

  // No userId header — apply cutover fallback if allowed.
  if (REQUIRE_TENANT_HEADER) {
    return {
      denied: jsonResponse(
        {
          error:
            "Missing X-Mimir-User-Id header (Phase 1E tenant gate enforced). " +
            "Every write must identify the caller's userId.",
        },
        401,
      ),
    };
  }
  if (!DEFAULT_TENANT_FALLBACK_USER_ID) {
    return {
      denied: jsonResponse(
        {
          error:
            "Missing X-Mimir-User-Id header and no GOBOT_DEFAULT_USER_ID fallback configured.",
        },
        401,
      ),
    };
  }
  // Cutover-window fallback: log once-per-request and use default user.
  console.error(
    `[mimir:tenant-gate] CUTOVER WARN: ${req.method} ${new URL(req.url).pathname} ` +
    `missing X-Mimir-User-Id — falling back to GOBOT_DEFAULT_USER_ID. ` +
    `Flip MIMIR_REQUIRE_TENANT_HEADER=true once gobot ships header-passing.`,
  );
  return {
    stamp: {
      userId: DEFAULT_TENANT_FALLBACK_USER_ID,
      organizationId: activeOrgScope,
      folioIds: folioIds.length > 0 ? folioIds : undefined,
      orgCanon: orgCanon || undefined,
    },
  };
}

/**
 * Phase 1E: extract a TenantFilter for read paths (recall, pulse, etc.).
 * Same cutover semantics as extractTenantStamp.
 */
function extractTenantFilter(req: Request): { filter: TenantFilter } | { denied: Response } {
  const r = extractTenantStamp(req);
  if ("denied" in r) return { denied: r.denied };
  // Read-only soft-bias signals (Knowledge Architecture P1): the active
  // workspace (boost) + active org display name (provenance label). These
  // never gate visibility — they only foreground + label.
  const { activeFolioIds, activeOrgName } = parseTenantHeaders(req);
  return {
    filter: {
      callerUserId: r.stamp.userId,
      activeOrgScope: r.stamp.organizationId,
      includeFolioIds: r.stamp.folioIds,
      activeFolioIds: activeFolioIds.length > 0 ? activeFolioIds : undefined,
      activeOrgName,
    },
  };
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
    const filterResult = extractTenantFilter(req);
    if ("denied" in filterResult) return filterResult.denied;
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
    const result = await recall(query, filterResult.filter, scope, timeRange, asOf, intent);
    return jsonResponse(result);
  }

  // ── Embed-batch (POST /api/embed-batch) ──
  // Pure embedding passthrough to the configured backend (oMLX). Used by
  // callers that can't reach the embedder directly (e.g. Convex cloud → the
  // localhost-only oMLX) and need to compute their OWN similarities over a
  // KNOWN small set — e.g. knowledge-board semantic discovery, which is an
  // N×N pairwise problem over a board's nuggets, NOT a brain-wide recall (recall
  // saturates the top-k with duplicate copies of the query nugget, crowding out
  // the genuinely-related ones). Bearer-gated (the global gate above); no tenant
  // scope needed — the caller already holds the text it sends, so this reads
  // nothing from the graph.
  if (path === "/api/embed-batch" && req.method === "POST") {
    const body = await req.json().catch(() => null);
    const texts: unknown = body?.texts;
    if (!Array.isArray(texts) || texts.length === 0) {
      return errorResponse("Missing texts: string[]");
    }
    if (texts.length > 256) {
      return errorResponse("Too many texts (max 256)");
    }
    if (!texts.every((t) => typeof t === "string")) {
      return errorResponse("texts must all be strings");
    }
    try {
      // Sequential to respect oMLX's single-stream embedder + its keep-alive
      // socket quirk (Connection: close per request, see embeddings.ts).
      const vectors: number[][] = [];
      for (const t of texts as string[]) {
        vectors.push(await generateEmbedding(t));
      }
      return jsonResponse({ vectors, dim: vectors[0]?.length ?? 0 });
    } catch (err) {
      return errorResponse(
        `Embedding failed: ${(err as Error).message}`,
        502,
      );
    }
  }

  // ── Retain (POST /api/retain) ──
  if (path === "/api/retain" && req.method === "POST") {
    const body = await req.json();
    if (!body.content) return errorResponse("Missing content field");
    const stampResult = extractTenantStamp(req);
    if ("denied" in stampResult) return stampResult.denied;
    // event_at: accept ISO 8601 string or Unix ms integer
    let eventAt: number | undefined;
    if (body.event_at !== undefined) {
      eventAt = typeof body.event_at === "string"
        ? new Date(body.event_at).getTime()
        : body.event_at;
    }
    const result = await retain(
      body.content,
      body.source || "manual",
      body.participants || [],
      eventAt,
      stampResult.stamp,
    );
    return jsonResponse(result);
  }

  // ── Pulse (GET /api/pulse?entity=...) ──
  if (path === "/api/pulse" && req.method === "GET") {
    const entity = url.searchParams.get("entity");
    if (!entity) return errorResponse("Missing ?entity= parameter");
    const filterResult = extractTenantFilter(req);
    if ("denied" in filterResult) return filterResult.denied;
    const result = await pulse(entity, filterResult.filter);
    return jsonResponse(result);
  }

  // ── Reflect (GET /api/reflect?scope=...&from=...&to=...) ──
  if (path === "/api/reflect" && req.method === "GET") {
    const filterResult = extractTenantFilter(req);
    if ("denied" in filterResult) return filterResult.denied;
    const scope = url.searchParams.get("scope") || undefined;
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    const timeRange = from || to
      ? { from: from ? parseInt(from) : undefined, to: to ? parseInt(to) : undefined }
      : undefined;
    const result = await reflect(filterResult.filter, scope, timeRange);
    return jsonResponse(result);
  }

  // ── Connect (POST /api/connect) ──
  if (path === "/api/connect" && req.method === "POST") {
    const body = await req.json();
    if (!body.source || !body.target) return errorResponse("Missing source or target");
    const filterResult = extractTenantFilter(req);
    if ("denied" in filterResult) return filterResult.denied;
    const result = await connect(
      body.source,
      body.target,
      filterResult.filter,
      body.rationale,
      body.edge_type,
    );
    return jsonResponse(result);
  }

  // ── Anchor (POST /api/anchor) ──
  if (path === "/api/anchor" && req.method === "POST") {
    const body = await req.json();
    if (!body.content || !body.domain) return errorResponse("Missing content or domain");
    const stampResult = extractTenantStamp(req);
    if ("denied" in stampResult) return stampResult.denied;
    const result = await anchor(body.content, body.domain, stampResult.stamp, body.weight);
    return jsonResponse(result);
  }

  // ── Triage (POST /api/triage) ──
  if (path === "/api/triage" && req.method === "POST") {
    const body = await req.json();
    if (!body.content || !body.source) return errorResponse("Missing content or source");
    const filterResult = extractTenantFilter(req);
    if ("denied" in filterResult) return filterResult.denied;
    const result = await triage(body.content, body.source, filterResult.filter, body.source_type);
    return jsonResponse(result);
  }

  // ── Process Queue (POST /api/process-queue) ──
  // Note: process-queue reads tenant from each Episode it processes — no
  // header required. This endpoint is a privileged operation (Bearer-auth
  // gates it).
  if (path === "/api/process-queue" && req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    const result = await processQueue(body.limit || 20);
    return jsonResponse(result);
  }

  // ── Forget (POST /api/forget) ──
  // Retract knowledge about an entity or episode. Marks entity summaries as
  // [RETRACTED] and sets all derived fact edges to belief_state='retracted'.
  // Source Episodes and Thoughts are preserved as immutable ground truth.
  // Phase 1E: tenant-scoped — caller can only retract their own entities.
  if (path === "/api/forget" && req.method === "POST") {
    const body = await req.json();
    if (!body.entity && !body.episode_id) {
      return errorResponse("Missing 'entity' (name) or 'episode_id'");
    }
    const filterResult = extractTenantFilter(req);
    if ("denied" in filterResult) return filterResult.denied;
    const result = await forget(
      body.entity || null,
      filterResult.filter,
      body.reason,
      body.episode_id,
    );
    return jsonResponse(result);
  }

  // ── Forget Cascade (POST /api/forget-cascade) ──
  // Phase 1E share-revocation cascade. Marks the revoked user's OWN
  // Episodes/Thoughts/Entities that reference the revoked folio via
  // `folio_ids` as `tenant_invisible_after = now`. The sharer's view
  // is UNTOUCHED — Episode = ground truth, never modified.
  //
  // Privileged endpoint: NOT caller-tenant-filtered. The Bearer-auth
  // gate ensures only the gobot daemon (holding MIMIR_SHARED_SECRET)
  // can invoke this. Triggered via Convex action from
  // folioMembers.removeMember.
  if (path === "/api/forget-cascade" && req.method === "POST") {
    const body = await req.json();
    if (!body.folio_id || !body.revoked_user_id) {
      return errorResponse(
        "Missing required fields: folio_id, revoked_user_id (Phase 1E cascade contract)",
      );
    }
    const result = await forgetByShareRevocation({
      folioId: body.folio_id,
      revokedUserId: body.revoked_user_id,
    });
    return jsonResponse(result);
  }

  // ── Explain Episode (GET /api/episode/:id) ──
  // Phase B2 of memory-hover-indicator sprint. Returns the entities +
  // fact-edges + crosslinks Mimir extracted from a single Episode, so
  // Observatory's "Show what Mosscap learned" reveal can render the graph
  // layer without requiring a separate full graph browser surface.
  //
  // Tenant-scoped: callers can only explain episodes they own OR have
  // folio-shared access to. Cross-tenant probes return status: "not_found"
  // (indistinguishable from a genuinely missing id — fail-closed for
  // existence-leak protection).
  if (path.startsWith("/api/episode/") && req.method === "GET") {
    const episodeId = path.slice("/api/episode/".length);
    if (!episodeId) return errorResponse("Missing episode id in path");
    const filterResult = extractTenantFilter(req);
    if ("denied" in filterResult) return filterResult.denied;
    const result = await explainEpisode(episodeId, filterResult.filter);
    // 404 for not_found so the proxy can distinguish from 500 transport
    // failure; body still carries the typed status field for callers that
    // parse JSON before checking the status code.
    return jsonResponse(result, result.status === "found" ? 200 : 404);
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

    // Phase 1E: /api/context is the prompt-injection entry point used by
    // gobot. Tenant scope is required so cross-tenant content never leaks
    // into Claude's prompt — that would break the "Provenance Always
    // Named" Design Constitution principle AND the 2026-04-12
    // fabrication-class incident's structural defense.
    const filterResult = extractTenantFilter(req);
    if ("denied" in filterResult) return filterResult.denied;
    const filter = filterResult.filter;

    const asOfRaw = url.searchParams.get("as_of");
    const asOf = asOfRaw ? parseInt(asOfRaw) : undefined;

    const g = getGraph();
    const MAX_EPISODE_CHARS = 2000; // Full episode content, capped for prompt budget
    const seenEpisodes = new Set<string>(); // Dedupe by episode content prefix

    // ── Phase 1: Find Thoughts matching query, hydrate to source Episodes ──
    // Phase 1E: tenant-scoped Thought + Episode matches.
    // as_of: filter Episodes by event_at so we only see content from before the cutoff.
    const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
    const thoughtSections: string[] = [];
    for (const word of words.slice(0, 3)) {
      const { fragment: tFrag, params: tParams } = applyTenantFilter("t", filter, "tt");
      const { fragment: epFrag, params: epParams } = applyTenantFilter("ep", filter, "tep");
      const asOfFilter = asOf !== undefined ? " AND t.created_at <= $asOf" : "";
      const params: Record<string, unknown> = { q: word, ...tParams, ...epParams };
      if (asOf !== undefined) params.asOf = asOf;
      const r = await g.query(
        `MATCH (t:Thought)
         WHERE toLower(t.content) CONTAINS toLower($q)
           AND ${tFrag}${asOfFilter}
         OPTIONAL MATCH (t)-[:extracted_from]->(ep:Episode)
         WHERE ${epFrag}
         RETURN t.content AS thought, t.created_at AS ts,
                ep.content AS episode, ep.source_type AS source
         ORDER BY t.created_at DESC LIMIT 3`,
        { params },
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
      const { fragment: eFrag, params: eParams } = applyTenantFilter("e", filter, "te");
      const r = await g.query(
        `MATCH (e:Entity)
         WHERE toLower(e.name) CONTAINS toLower($w)
           AND NOT e.summary STARTS WITH '[INVALIDATED]'
           AND NOT e.summary STARTS WITH '[RETRACTED]'
           AND ${eFrag}
         RETURN e.id AS id, e.name AS name, e.type AS type, e.summary AS summary
         LIMIT 3`,
        { params: { w: word, ...eParams } },
      );
      if (r.data) {
        for (const row of r.data as Record<string, unknown>[]) {
          const name = row.name as string;
          const id = row.id as string;
          if (seenEntityNames.has(name)) continue;
          seenEntityNames.add(name);

          // Hydrate: fetch source episode for this entity (tenant-scoped).
          const hydrated = await hydrateNode(id, "Entity", filter);
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

        // Phase 1E: fact-edge tenant scope. The edge itself is stamped
        // with tenant_user_id; both endpoint entities must also be in
        // the caller's tenant.
        const factResult = await g.query(
          `MATCH (a:Entity)-[r]->(b:Entity)
           WHERE (toLower(a.name) = toLower($name) OR toLower(b.name) = toLower($name))
             AND r.valid_until IS NULL
             AND r.fact IS NOT NULL
             AND r.belief_state IN ['confirmed', 'asserted']
             AND r.tenant_user_id = $callerUserId
             AND a.tenant_user_id = $callerUserId
             AND b.tenant_user_id = $callerUserId${asOfFactFilter}
           RETURN a.name AS from_name, b.name AS to_name, r.fact AS fact,
                  r.belief_state AS state, r.source_authority AS authority
           ORDER BY r.source_authority DESC LIMIT 3`,
          { params: { ...factParams, callerUserId: filter.callerUserId } },
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

    // ── Phase 3: Active anchors (caller's own + org canon) ──
    // P3 org-anchor grant: an org member sees their OWN anchors PLUS the org's
    // canon anchors (tenant_org_id == active org AND org_canon) — so Lighthouse
    // pedagogy anchors promoted to org canon are inherited by every workspace
    // member's always-on context. Additive (owner-only when no active org;
    // cross-user isolation stays on the ownership clause). Mirrors the recall
    // grant in graph.applyTenantFilter. LIMIT 12 (interim; relevance-ranking
    // needs anchor embeddings — remaining anchor-overhaul card scope).
    const anchorOrgGrant = filter.activeOrgScope
      ? " OR (a.tenant_org_id = $orgScope AND a.org_canon = true)"
      : "";
    const anchorsResult = await g.query(
      `MATCH (a:Anchor)
       WHERE a.weight > 0
         AND (a.tenant_user_id = $callerUserId${anchorOrgGrant})
       RETURN a.content AS c, a.domain AS d LIMIT 12`,
      {
        params: {
          callerUserId: filter.callerUserId,
          ...(filter.activeOrgScope ? { orgScope: filter.activeOrgScope } : {}),
        },
      },
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
  // Phase 1E: tenant-scoped — each caller sees only their own person/org/
  // project entities. Triage context from another user's graph would leak
  // their relationship network.
  if (path === "/api/entities" && req.method === "GET") {
    const filterResult = extractTenantFilter(req);
    if ("denied" in filterResult) return filterResult.denied;
    const g = getGraph();
    const r = await g.query(
      `MATCH (e:Entity)
       WHERE e.type IN ['person', 'org', 'project']
         AND e.tenant_user_id = $callerUserId
       RETURN e.name AS name, e.type AS type
       ORDER BY e.type, e.name
       LIMIT 50`,
      { params: { callerUserId: filterResult.filter.callerUserId } },
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
  console.log("  POST /api/forget");
  console.log("  POST /api/forget-cascade  (Phase 1E share-revocation)");
  console.log("  GET  /api/episode/:id     (Phase B2 explain — entities + edges + crosslinks)");
  console.log(
    `[mimir:phase-1e] tenant-header gate: ${REQUIRE_TENANT_HEADER ? "ENFORCED (fail-closed)" : "CUTOVER WINDOW (fallback to GOBOT_DEFAULT_USER_ID)"}`,
  );

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
