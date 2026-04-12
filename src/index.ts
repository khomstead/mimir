#!/usr/bin/env bun
/**
 * Mimir — Headless Intelligence Layer for the Speki Ecosystem
 *
 * Exposes 7 knowledge verbs via MCP (stdio transport).
 * Graph-backed by FalkorDBLite. Model-agnostic.
 *
 * Usage: bun run src/index.ts
 *   (normally spawned by Claude Code via .mcp.json)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { initGraph, closeGraph } from "./graph.js";
import { retain } from "./verbs/retain.js";
import { recall } from "./verbs/recall.js";
import { pulse } from "./verbs/pulse.js";
import { reflect } from "./verbs/reflect.js";
import { connect } from "./verbs/connect.js";
import { anchor } from "./verbs/anchor.js";
import { triage } from "./verbs/triage.js";
import { processQueue } from "./verbs/process-queue.js";

// Data path from env, with a sensible default for Kyle's personal brain
const DATA_PATH =
  process.env.MIMIR_DATA_PATH || process.env.BRAIN_DATA_PATH || "/Volumes/AI-Lab/falkordb-data/personal-brain";

const server = new McpServer({
  name: "mimir",
  version: "0.2.0",
});

// --- retain tool ---
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
  },
  async ({ content, source, participants }) => {
    try {
      const result = await retain(content, source, participants);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (err: any) {
      return {
        content: [{ type: "text" as const, text: `Error in retain: ${err.message}` }],
        isError: true,
      };
    }
  },
);

// --- recall tool ---
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
  },
  async ({ query, scope, time_range_from, time_range_to }) => {
    try {
      const timeRange =
        time_range_from || time_range_to
          ? { from: time_range_from, to: time_range_to }
          : undefined;
      const result = await recall(query, scope, timeRange);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (err: any) {
      return {
        content: [{ type: "text" as const, text: `Error in recall: ${err.message}` }],
        isError: true,
      };
    }
  },
);

// --- pulse tool ---
server.tool(
  "pulse",
  "Get a status synthesis for an entity or domain. " +
    "Returns recent thoughts, active anchors, open commitments, connections, " +
    "and unresolved tensions — a comprehensive view of the current state.",
  {
    entity_or_domain: z.string().describe(
      "Name of a person, project, concept, or domain to get the pulse of"
    ),
  },
  async ({ entity_or_domain }) => {
    try {
      const result = await pulse(entity_or_domain);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (err: any) {
      return {
        content: [{ type: "text" as const, text: `Error in pulse: ${err.message}` }],
        isError: true,
      };
    }
  },
);

// --- reflect tool ---
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
      const timeRange =
        time_range_from || time_range_to
          ? { from: time_range_from, to: time_range_to }
          : undefined;
      const result = await reflect(scope, timeRange);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (err: any) {
      return {
        content: [{ type: "text" as const, text: `Error in reflect: ${err.message}` }],
        isError: true,
      };
    }
  },
);

// --- connect tool ---
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
      const result = await connect(source, target, rationale, edge_type);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (err: any) {
      return {
        content: [{ type: "text" as const, text: `Error in connect: ${err.message}` }],
        isError: true,
      };
    }
  },
);

// --- anchor tool ---
server.tool(
  "anchor",
  "Create a load-bearing philosophy (Anchor) that constrains downstream work in a domain. " +
    "Anchors are never silently superseded — old anchors get timestamps and supersedes edges. " +
    "Use sparingly for deeply held principles, not preferences.",
  {
    content: z.string().describe(
      "The philosophical statement or guiding principle"
    ),
    domain: z.string().describe(
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
      const result = await anchor(content, domain, weight);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (err: any) {
      return {
        content: [{ type: "text" as const, text: `Error in anchor: ${err.message}` }],
        isError: true,
      };
    }
  },
);

// --- triage tool ---
server.tool(
  "triage",
  "Process an external signal (email, message, notification) through Mimir's " +
    "intelligence layer. Identifies related entities and anchors, assesses priority, " +
    "and routes the signal appropriately.",
  {
    content: z.string().describe("The signal content (email body, message text, etc.)"),
    source: z.string().describe(
      "Source identifier (email address, sender name, channel name)"
    ),
    source_type: z
      .enum(["email", "message", "notification", "calendar", "other"])
      .optional()
      .default("message")
      .describe("Type of external signal"),
  },
  async ({ content, source, source_type }) => {
    try {
      const result = await triage(content, source, source_type);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (err: any) {
      return {
        content: [{ type: "text" as const, text: `Error in triage: ${err.message}` }],
        isError: true,
      };
    }
  },
);

// --- process_queue tool ---
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
      const result = await processQueue(limit);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (err: any) {
      return {
        content: [{ type: "text" as const, text: `Error in process_queue: ${err.message}` }],
        isError: true,
      };
    }
  },
);

// --- startup ---
async function main() {
  console.error("[mimir] Starting Mimir MCP Server...");
  console.error(`[mimir] Data path: ${DATA_PATH}`);

  console.error(`[mimir] ANTHROPIC_API_KEY: ${process.env.ANTHROPIC_API_KEY ? "set (" + process.env.ANTHROPIC_API_KEY.slice(0, 12) + "...)" : "NOT SET"}`);
  console.error(`[mimir] OPENAI_API_KEY: ${process.env.OPENAI_API_KEY ? "set" : "NOT SET"}`);

  await initGraph(DATA_PATH);
  console.error("[mimir] FalkorDB graph initialized");

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[mimir] MCP server connected via stdio");

  // Graceful shutdown
  const shutdown = async () => {
    console.error("[mimir] Shutting down...");
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
