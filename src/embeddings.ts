/**
 * Embedding generation for Thought nodes — provider-agnostic, local-first.
 *
 * Default backend: **oMLX** (local, OpenAI-compatible) serving
 * `Qwen3-Embedding-0.6B-8bit` at `OMLX_BASE_URL`. Native 1024-dim, vectors are
 * pre-normalized (L2 ≈ 1) so FalkorDB cosine works directly. Local + model-agnostic
 * by design (Kyle's no-vendor-lock principle) — switchable via `MIMIR_EMBED_BACKEND`.
 *
 * FAIL LOUD (the lesson): the previous OpenAI-only implementation returned a SILENT
 * zero vector whenever no API key was present. With no key configured, every stored
 * AND every query vector was all-zeros → FalkorDB cosine distance NaN → recall coerced
 * NaN to a flat 0.5 → semantic recall was dead for weeks while looking alive. This
 * module now THROWS on an unreachable embedder, a dimension mismatch, or a degenerate
 * (≈zero / non-finite) vector. A dead embedder must be loud, never faked.
 */

const EMBEDDING_DIM = 1024;
const DEFAULT_OMLX_MODEL = "Qwen3-Embedding-0.6B-8bit";
const DEFAULT_OPENAI_MODEL = "text-embedding-3-small";

type EmbedBackend = "omlx" | "openai";

/**
 * Read an env var, falling back to reading a `.env` file directly — the launchd
 * service (and MCP stdio spawns) may not inherit the shell env. Mirrors the proven
 * loader in extraction.ts (which is how ANTHROPIC_API_KEY reaches the service).
 * Candidates: mimir/.env (standalone repo), then a parent .env if ever nested.
 * Caches into process.env on first hit.
 */
function readEnv(name: string): string | undefined {
  if (process.env[name]) return process.env[name];

  const path = require("path");
  const fs = require("fs");
  const candidates = [
    path.resolve(__dirname, "../.env"), // mimir/.env (standalone)
    path.resolve(__dirname, "../../.env"), // parent .env (if ever nested)
  ];

  for (const envPath of candidates) {
    try {
      const envContent = fs.readFileSync(envPath, "utf-8");
      const match = envContent.match(new RegExp(`^${name}=(.+)$`, "m"));
      if (match) {
        const val = match[1].trim().replace(/^["']|["']$/g, "");
        process.env[name] = val; // cache for future calls
        return val;
      }
    } catch {
      // This candidate doesn't exist — try next.
    }
  }
  return undefined;
}

function getBackend(): EmbedBackend {
  return (readEnv("MIMIR_EMBED_BACKEND") || "omlx").toLowerCase() === "openai"
    ? "openai"
    : "omlx";
}

const OMLX_MAX_ATTEMPTS = 4;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Embed via oMLX's OpenAI-compatible /v1/embeddings endpoint.
 *
 * GOTCHA #1: oMLX prepends a single 0x20 space byte before the JSON body, so a
 * raw `JSON.parse` fails at column 2. We parse from the first `{`.
 *
 * GOTCHA #2: oMLX closes idle keep-alive sockets, so a reused pooled connection
 * yields ECONNRESET ("socket connection was closed unexpectedly") on the next
 * request. We send `Connection: close` to avoid reuse AND retry transient
 * network errors with backoff — important for the re-embed backfill's hundreds
 * of sequential calls.
 */
async function embedViaOmlx(text: string): Promise<number[]> {
  const baseUrl = readEnv("OMLX_BASE_URL");
  const apiKey = readEnv("OMLX_API_KEY");
  const model = readEnv("MIMIR_EMBED_MODEL") || DEFAULT_OMLX_MODEL;

  if (!baseUrl) {
    throw new Error(
      "[mimir:embeddings] OMLX_BASE_URL is not set — cannot embed. " +
        "Add OMLX_BASE_URL (and OMLX_API_KEY) to mimir/.env.",
    );
  }

  const url = `${baseUrl.replace(/\/$/, "")}/v1/embeddings`;
  const init: RequestInit = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Connection: "close", // avoid keep-alive socket reuse (ECONNRESET)
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({ model, input: text.slice(0, 8000) }),
  };

  let lastErr: unknown;
  for (let attempt = 1; attempt <= OMLX_MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, init);
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        // 5xx is worth retrying; 4xx is a hard config/request error.
        if (res.status >= 500 && attempt < OMLX_MAX_ATTEMPTS) {
          lastErr = new Error(`oMLX HTTP ${res.status}: ${body.slice(0, 200)}`);
          await sleep(150 * attempt);
          continue;
        }
        throw new Error(
          `[mimir:embeddings] oMLX HTTP ${res.status} from ${baseUrl}: ${body.slice(0, 200)}`,
        );
      }

      // Trim the leading-space quirk, then fall back to slicing from the first brace.
      const raw = await res.text();
      let parsed: { data?: Array<{ embedding?: number[] }> };
      try {
        parsed = JSON.parse(raw.trim());
      } catch {
        const firstBrace = raw.indexOf("{");
        if (firstBrace < 0) {
          throw new Error(
            `[mimir:embeddings] oMLX returned non-JSON body: ${raw.slice(0, 120)}`,
          );
        }
        parsed = JSON.parse(raw.slice(firstBrace));
      }

      const embedding = parsed?.data?.[0]?.embedding;
      if (!Array.isArray(embedding)) {
        throw new Error(
          "[mimir:embeddings] oMLX response missing data[0].embedding array",
        );
      }
      return embedding;
    } catch (err) {
      lastErr = err;
      const msg = (err as Error).message ?? String(err);
      // Retry only transient network/socket errors; rethrow hard errors.
      const transient =
        msg.includes("ECONNRESET") ||
        msg.includes("socket connection was closed") ||
        msg.includes("Unable to connect") ||
        msg.includes("fetch failed") ||
        msg.includes("ConnectionRefused") ||
        msg.includes("timed out");
      if (transient && attempt < OMLX_MAX_ATTEMPTS) {
        await sleep(150 * attempt);
        continue;
      }
      throw err;
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error(`[mimir:embeddings] oMLX failed: ${String(lastErr)}`);
}

/**
 * Optional escape hatch: OpenAI embeddings. NON-DEFAULT — only used when
 * MIMIR_EMBED_BACKEND=openai. Note the returned dimension must match
 * EMBEDDING_DIM (1024) or generateEmbedding() throws; switching here also
 * requires rebuilding the FalkorDB vector index to the matching dimension.
 */
async function embedViaOpenAI(text: string): Promise<number[]> {
  const key = readEnv("OPENAI_API_KEY");
  if (!key) {
    throw new Error(
      "[mimir:embeddings] MIMIR_EMBED_BACKEND=openai but OPENAI_API_KEY is not set.",
    );
  }
  const OpenAI = (await import("openai")).default;
  const client = new OpenAI({ apiKey: key });
  const model = readEnv("MIMIR_EMBED_MODEL") || DEFAULT_OPENAI_MODEL;
  const response = await client.embeddings.create({
    model,
    input: text.slice(0, 8000),
  });
  return response.data[0].embedding;
}

/**
 * Generate an embedding for `text`. Throws (loud) on any failure — never returns
 * a silent zero vector.
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  const backend = getBackend();
  const vec =
    backend === "openai"
      ? await embedViaOpenAI(text)
      : await embedViaOmlx(text);

  // FAIL LOUD #1 — dimension contract. The vector index is built for EMBEDDING_DIM;
  // a mismatched vector would silently never match anything.
  if (vec.length !== EMBEDDING_DIM) {
    throw new Error(
      `[mimir:embeddings] dimension mismatch: got ${vec.length}, expected ${EMBEDDING_DIM} ` +
        `(backend=${backend}). The vector index is built for ${EMBEDDING_DIM} — refusing to ` +
        `store a mismatched vector.`,
    );
  }

  // FAIL LOUD #2 — degenerate vector. An all-zero / non-finite vector is the exact
  // signature of the silent failure this migration killed.
  let sumSq = 0;
  for (const x of vec) sumSq += x * x;
  if (!Number.isFinite(sumSq) || sumSq < 1e-9) {
    throw new Error(
      `[mimir:embeddings] degenerate embedding (L2²=${sumSq}) from backend=${backend} — ` +
        `refusing to store a zero/non-finite vector. This is the silent failure mode the ` +
        `local-embeddings migration was built to prevent.`,
    );
  }

  return vec;
}

export { EMBEDDING_DIM };
