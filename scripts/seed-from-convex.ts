#!/usr/bin/env bun
/**
 * Mimir — Seed from Convex Knowledge Table
 *
 * Pulls active knowledge entries, key contacts, and active folios
 * from the Convex deployment and captures them into Mimir via retain.
 *
 * Usage: bun run scripts/seed-from-convex.ts [--dry-run]
 *
 * Requires: CONVEX_URL and OBSERVATORY_AUTH_TOKEN in env (or parent .env)
 */

import { ConvexHttpClient } from "convex/browser";
import { initGraph, closeGraph } from "../src/graph.js";
import { retain } from "../src/verbs/retain.js";

// Load env
function loadEnv() {
  const fs = require("fs");
  const path = require("path");
  const candidates = [
    path.resolve(__dirname, "../.env"),
    path.resolve(__dirname, "../../gobot/.env"),
  ];
  for (const envPath of candidates) {
    try {
      const content = fs.readFileSync(envPath, "utf-8");
      for (const line of content.split("\n")) {
        const match = line.match(/^([A-Z_]+)=(.+)$/);
        if (match && !process.env[match[1]]) {
          process.env[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
        }
      }
      console.log(`[seed] Loaded env from ${envPath}`);
    } catch {}
  }
}

loadEnv();

const DRY_RUN = process.argv.includes("--dry-run");
const DATA_PATH = process.env.MIMIR_DATA_PATH || "/Volumes/AI-Lab/falkordb-data/personal-brain";
const CONVEX_URL = process.env.CONVEX_URL;
const TOKEN = process.env.OBSERVATORY_AUTH_TOKEN;

if (!CONVEX_URL) {
  console.error("[seed] CONVEX_URL not set. Cannot connect to Convex.");
  process.exit(1);
}

async function main() {
  console.log(`[seed] Mode: ${DRY_RUN ? "DRY RUN" : "LIVE"}`);
  console.log(`[seed] Convex: ${CONVEX_URL}`);

  const client = new ConvexHttpClient(CONVEX_URL);
  await initGraph(DATA_PATH);

  let totalSeeded = 0;

  // 1. Seed from knowledge table
  console.log("\n[seed] === Knowledge entries ===");
  try {
    const knowledge = await client.query("knowledge:listAll" as any, {}) as any[];
    const active = knowledge.filter((k: any) => k.status !== "archived");
    console.log(`[seed] Found ${active.length} active knowledge entries`);

    for (const entry of active) {
      const content = `[Knowledge/${entry.category}] ${entry.title}\n\n${entry.content}`;
      if (DRY_RUN) {
        console.log(`  Would retain: ${entry.title.slice(0, 60)}`);
      } else {
        try {
          await retain(content, "manual");
          console.log(`  ✓ ${entry.title.slice(0, 60)}`);
          totalSeeded++;
        } catch (err: any) {
          console.error(`  ✗ ${entry.title.slice(0, 40)}: ${err.message}`);
        }
      }
    }
  } catch (err: any) {
    console.error(`[seed] Knowledge fetch failed: ${err.message}`);
  }

  // 2. Seed key contacts as entities (via retain with structured context)
  console.log("\n[seed] === Key contacts ===");
  try {
    const contacts = await client.query("observatory/contacts:list" as any, { token: TOKEN }) as any[];
    // Only seed contacts with high interaction scores or keepWarm
    const keyContacts = contacts
      .filter((c: any) => c.keepWarm || (c.interactionScore && c.interactionScore > 3) || c.domains?.length > 0)
      .slice(0, 30);
    console.log(`[seed] Found ${keyContacts.length} key contacts (of ${contacts.length} total)`);

    for (const contact of keyContacts) {
      const parts = [
        `${contact.name} is a contact`,
        contact.organization ? `at ${contact.organization}` : "",
        contact.role ? `(${contact.role})` : "",
        contact.domains?.length ? `in domains: ${contact.domains.join(", ")}` : "",
        contact.keepWarm ? "— flagged as keep-warm relationship" : "",
      ].filter(Boolean);
      const content = parts.join(" ");

      if (DRY_RUN) {
        console.log(`  Would retain: ${contact.name}`);
      } else {
        try {
          await retain(content, "manual", [contact.name]);
          console.log(`  ✓ ${contact.name}`);
          totalSeeded++;
        } catch (err: any) {
          console.error(`  ✗ ${contact.name}: ${err.message}`);
        }
      }
    }
  } catch (err: any) {
    console.error(`[seed] Contacts fetch failed: ${err.message}`);
  }

  // 3. Seed active folios (projects) as structured context
  console.log("\n[seed] === Active folios ===");
  try {
    const folios = await client.query("mosscapFolios:list" as any, { status: "active" }) as any[];
    console.log(`[seed] Found ${folios.length} active folios`);

    for (const folio of folios) {
      const folioTitle = folio.title || folio.name || folio.slug || "(untitled)";
      const content = [
        `Project: ${folioTitle}`,
        folio.description ? `Description: ${folio.description}` : "",
        folio.context ? `Context: ${folio.context.slice(0, 300)}` : "",
      ].filter(Boolean).join("\n");

      if (DRY_RUN) {
        console.log(`  Would retain: ${folioTitle}`);
      } else {
        try {
          await retain(content, "manual");
          console.log(`  ✓ ${folioTitle}`);
          totalSeeded++;
        } catch (err: any) {
          console.error(`  ✗ ${folioTitle}: ${err.message}`);
        }
      }
    }
  } catch (err: any) {
    console.error(`[seed] Folios fetch failed: ${err.message}`);
  }

  console.log(`\n[seed] ${DRY_RUN ? "Would seed" : "Seeded"} ${totalSeeded} items into Mimir.`);

  await closeGraph();
}

main().catch((err) => {
  console.error("[seed] Fatal error:", err);
  process.exit(1);
});
