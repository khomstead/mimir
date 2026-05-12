/**
 * Mimir — Retain Verb
 *
 * The universal capture verb. Takes raw text and:
 * 1. Creates an Episode node (ground truth preservation)
 * 2. Extracts entities and relationships via LLM
 * 3. Ensures extracted entities exist in the graph (find or create)
 * 4. Creates extracted relationships as edges
 * 5. Generates an embedding for the content
 * 6. Checks for evolving thoughts (>0.90 similarity)
 * 7. Creates a Thought node with the embedding
 * 8. Links Thought -> Episode via extracted_from
 * 9. Links Thought -> domain entities via contributes_to
 * 10. Checks for anchor tensions in relevant domains
 * 11. Returns RetainResponse with all extracted info + action signals
 */

import {
  createNode,
  createEdge,
  createFactEdge,
  findEntityByName,
  getGraph,
  vectorSearch,
  updateEntitySummary,
  invalidateEntitySummary,
  SOURCE_AUTHORITY,
  DEFAULT_AUTHORITY,
} from "../graph.js";
import { generateEmbedding } from "../embeddings.js";
import { extractFromText } from "../extraction.js";
import { evaluateTension } from "../tension-eval.js";
import type {
  RetainResponse,
  EpisodeSourceType,
  ThoughtSource,
  TenantStamp,
  TenantFilter,
} from "../types.js";

/**
 * Phase 1E helper: convert a TenantStamp (write side) into the matching
 * TenantFilter (read side) for the same caller. Used inside retain() to
 * read back the caller's own entities (Mem0 action-intent pipeline).
 */
function stampToFilter(tenant: TenantStamp): TenantFilter {
  return {
    callerUserId: tenant.userId,
    activeOrgScope: tenant.organizationId,
    includeFolioIds: tenant.folioIds,
  };
}

/**
 * Map a source string to a valid EpisodeSourceType.
 * Episode nodes accept: "conversation" | "email" | "document" | "voice" | "meeting"
 */
function toEpisodeSource(source: string): EpisodeSourceType {
  const mapping: Record<string, EpisodeSourceType> = {
    chat: "conversation",
    manual: "conversation",
    conversation: "conversation",
    email: "email",
    document: "document",
    voice: "voice",
    meeting: "meeting",
    distillation: "document",
  };
  return mapping[source] ?? "conversation";
}

/**
 * Map a source string to a valid ThoughtSource.
 * Thought nodes accept: "chat" | "voice" | "email" | "manual" | "meeting" | "distillation"
 */
function toThoughtSource(source: string): ThoughtSource {
  const valid = new Set<ThoughtSource>([
    "chat",
    "voice",
    "email",
    "manual",
    "meeting",
    "distillation",
  ]);
  return valid.has(source as ThoughtSource)
    ? (source as ThoughtSource)
    : "manual";
}

export async function retain(
  content: string,
  source: string = "manual",
  participants: string[] = [],
  eventAt?: number,
  tenant?: TenantStamp,
): Promise<RetainResponse> {
  const now = Date.now();

  // Phase 1E: tenant stamp is REQUIRED for retain. Service layer maps
  // missing X-Mimir-User-Id → 401 (when gate enabled); during the
  // two-step header-cutover window the service may default to
  // GOBOT_DEFAULT_USER_ID. Either way, by the time we reach retain()
  // the tenant must be set.
  if (!tenant || !tenant.userId) {
    throw new Error(
      "retain: tenant stamp required (Phase 1E). " +
      "Callers must supply { userId, organizationId?, folioIds? } — " +
      "there is no anonymous retain path.",
    );
  }
  const filter = stampToFilter(tenant);

  // MIMIR_FAST_RETAIN: dual-stream fast path (MAGMA pattern).
  // When enabled, retain() skips all LLM extraction and immediately returns —
  // the consolidation worker handles extraction asynchronously in the background.
  // This makes every retain() call O(1) graph append, never blocked by LLM latency.
  const fastRetain = process.env.MIMIR_FAST_RETAIN === "true";

  // 1. Extract entities and relationships via LLM (may return queued sentinel)
  // In fast-retain mode, always defer to the consolidation worker.
  let extraction: Awaited<ReturnType<typeof extractFromText>>;
  let isQueued: boolean;
  if (fastRetain) {
    isQueued = true;
    extraction = { queued: true } as any;
  } else {
    extraction = await extractFromText(content, filter);
    isQueued = "queued" in extraction && extraction.queued === true;
  }

  // 2. Create Episode (ground truth) — processed:false when extraction was deferred
  // event_at = when this actually happened (may differ from ingestion time).
  // Example: retaining "We met last Tuesday" on Friday → event_at = Tuesday, timestamp = Friday.
  const episodeId = await createNode("Episode", {
    content,
    source_type: toEpisodeSource(source),
    participants,
    timestamp: now,          // ingestion time (always now)
    event_at: eventAt ?? now, // event time (caller-supplied, defaults to ingestion time)
    processed: !isQueued,
  }, tenant);

  // 3-4. Entity handling with action intents (Mem0 ADD/UPDATE/INVALIDATE pattern).
  // Phase 1E strict per-tenant entity isolation: findEntityByName scoped to
  // caller; INVALIDATE/UPDATE can only mutate caller's own entities.
  const entityIds: Record<string, string> = {};
  if (!isQueued) {
    // Prefer entity_actions (action-intent-aware) over plain entities
    const entityList = extraction.entity_actions ?? extraction.entities.map((e) => ({
      ...e,
      fact_summary: "",
      action: "ADD" as const,
    }));

    for (const entity of entityList) {
      const searchName = entity.canonical_name || entity.name;
      const existing = await findEntityByName(searchName, filter);

      if (existing) {
        entityIds[entity.name] = existing.id;

        // Apply action intent — scoped to caller's tenant (downgrade-only).
        if ("action" in entity) {
          if (entity.action === "UPDATE" && entity.fact_summary) {
            // Mem0 UPDATE: merge new info into existing summary
            await updateEntitySummary(existing.id, entity.fact_summary, filter);
          } else if (entity.action === "INVALIDATE") {
            // Mem0 INVALIDATE: soft-delete the summary (caller's view only)
            await invalidateEntitySummary(existing.id, filter);
          }
          // ADD for existing entity = no-op (already exists)
        }
      } else {
        // New entity — create with fact_summary (not content.slice(0, 100)).
        // Stamped with caller's tenant — per-tenant strict isolation.
        const summary = ("fact_summary" in entity && entity.fact_summary)
          ? entity.fact_summary
          : `Mentioned in: ${content.slice(0, 200)}`;
        const newId = await createNode("Entity", {
          name: entity.name,
          type: entity.type,
          summary,
          synonyms:
            entity.canonical_name && entity.canonical_name !== entity.name
              ? [entity.canonical_name]
              : [],
          created_at: now,
          updated_at: now,
        }, tenant);
        entityIds[entity.name] = newId;
      }

      // Link entity to episode via "involves" (always, regardless of action)
      await createEdge(
        "Episode",
        episodeId,
        "Entity",
        entityIds[entity.name],
        "involves",
        { source_episode_id: episodeId },
      );
    }

    // Create fact-bearing edges (Graphiti pattern) if available — tenant-stamped.
    if (extraction.facts && extraction.facts.length > 0) {
      const authority = SOURCE_AUTHORITY[source] ?? DEFAULT_AUTHORITY;
      for (const fact of extraction.facts) {
        const fromId = entityIds[fact.from];
        const toId = entityIds[fact.to];
        if (fromId && toId) {
          const validAt = fact.valid_at ? new Date(fact.valid_at).getTime() : null;
          const invalidAt = fact.invalid_at ? new Date(fact.invalid_at).getTime() : null;
          await createFactEdge(
            "Entity", fromId,
            "Entity", toId,
            fact.edge_type,
            fact.fact,
            episodeId,
            validAt,
            invalidAt,
            authority,
            "asserted",
            tenant,
          );
        }
      }
    }

    // Fallback: create plain edges from relationships[] if no facts[]
    if (!extraction.facts || extraction.facts.length === 0) {
      for (const rel of extraction.relationships) {
        const fromId = entityIds[rel.from];
        const toId = entityIds[rel.to];
        if (fromId && toId) {
          await createEdge("Entity", fromId, "Entity", toId, rel.type, {
            source_episode_id: episodeId,
            confidence: extraction.confidence,
          });
        }
      }
    }
  }

  // 5. Generate embedding
  const embedding = await generateEmbedding(content);

  // 6. Check for evolving thoughts (>0.90 similarity) — scoped to caller's tenant.
  let evolvesFromId: string | null = null;
  try {
    const similarThoughts = await vectorSearch(embedding, 3, filter);
    if (similarThoughts.length > 0) {
      const closest = similarThoughts[0];
      if (closest.score < 0.1) {
        evolvesFromId = closest.id;
      }
    }
  } catch {
    // Vector search may fail if no Thought nodes exist yet — that's fine
  }

  // 7. Create Thought node (tenant-stamped)
  const thoughtId = await createNode("Thought", {
    content,
    embedding,
    source: toThoughtSource(source),
    confidence: isQueued ? 0 : extraction.confidence,
    created_at: now,
  }, tenant);

  // 8. Link Thought -> Episode (provenance)
  await createEdge("Thought", thoughtId, "Episode", episodeId, "extracted_from", {
    source_episode_id: episodeId,
  });

  // 9. Create evolves edge if similar thought found
  if (evolvesFromId) {
    await createEdge("Thought", evolvesFromId, "Thought", thoughtId, "evolves", {
      source_episode_id: episodeId,
      confidence: isQueued ? 0 : extraction.confidence,
    });
  }

  // 10-11. Domain linking and anchor tension checks — ONLY when extraction succeeded.
  // Phase 1E: domain entity lookup and anchor scan filtered to caller's tenant.
  const tensions: RetainResponse["tensions"] = [];
  if (!isQueued) {
    for (const domain of extraction.domains) {
      const domainEntity = await findEntityByName(domain, filter);
      if (domainEntity) {
        await createEdge(
          "Thought",
          thoughtId,
          "Entity",
          domainEntity.id,
          "contributes_to",
          { source_episode_id: episodeId },
        );
      }
    }

    for (const domain of extraction.domains) {
      try {
        const g = getGraph();
        // Phase 1E: scope anchor scan to caller's tenant (anchors are
        // per-user philosophies; one user's anchor doesn't constrain
        // another's content).
        const anchorsResult = await g.query(
          `MATCH (a:Anchor)
           WHERE a.domain = $domain AND a.weight > 0
             AND a.tenant_user_id = $callerUserId
           RETURN a.id AS id, a.content AS content`,
          { params: { domain, callerUserId: tenant.userId } },
        );
        if (anchorsResult.data) {
          for (const row of anchorsResult.data as Record<string, unknown>[]) {
            const anchorId = row.id as string;
            const anchorContent = row.content as string;

            // LLM-powered tension evaluation
            const evaluation = await evaluateTension(anchorContent, content);

            if (evaluation && (evaluation.alignment === "tensions" || evaluation.alignment === "contradicts")) {
              tensions.push({
                anchor_id: anchorId,
                anchor_content: anchorContent,
                tension_description: evaluation.tension_description,
              });

              // Create tensions_with edge in the graph
              await createEdge("Thought", thoughtId, "Anchor", anchorId, "tensions_with", {
                source_episode_id: episodeId,
                confidence: evaluation.severity,
              });
            }
          }
        }
      } catch {
        // Anchor query failure is non-fatal
      }
    }
  }

  return {
    stored: true,
    thought_id: thoughtId,
    episode_id: episodeId,
    entities_extracted: extraction.entities.map((e) => e.name),
    connections: extraction.domains,
    tensions,
    extracted: {
      commitment: extraction.commitment,
      deadline: extraction.deadline,
      entity: extraction.entities[0]?.name || null,
      action_required: extraction.commitment !== null,
    },
    ...(isQueued ? { extraction_deferred: true } : {}),
  };
}
