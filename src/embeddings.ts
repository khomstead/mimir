/**
 * OpenAI embedding generation for Thought nodes.
 *
 * Uses text-embedding-3-small (1536 dimensions) by default.
 * Falls back gracefully if OPENAI_API_KEY is not set (returns zero vector
 * so tests can run without an API key).
 */

import OpenAI from "openai";

const EMBEDDING_MODEL = "text-embedding-3-small";
const EMBEDDING_DIM = 1536;

let openai: OpenAI | null = null;

function getOpenAIKey(): string | undefined {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;

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
      const match = envContent.match(/^OPENAI_API_KEY=(.+)$/m);
      if (match) {
        const key = match[1].trim().replace(/^["']|["']$/g, "");
        process.env.OPENAI_API_KEY = key;
        console.error(`[mimir:embeddings] Loaded OPENAI_API_KEY from ${envPath}`);
        return key;
      }
    } catch {
      // This candidate doesn't exist — try next
    }
  }
  return undefined;
}

function getClient(): OpenAI | null {
  if (!openai) {
    const key = getOpenAIKey();
    if (key) openai = new OpenAI({ apiKey: key });
  }
  return openai;
}

export async function generateEmbedding(text: string): Promise<number[]> {
  const client = getClient();
  if (!client) {
    // No API key — return zero vector for local testing
    return new Array(EMBEDDING_DIM).fill(0);
  }

  const response = await client.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text.slice(0, 8000), // API limit safety
  });

  return response.data[0].embedding;
}

export { EMBEDDING_DIM };
