/**
 * Mimir — Queue Processor
 *
 * Processes Episodes that were deferred during retain() when no LLM
 * was available. Finds Episodes with processed:false, runs extraction,
 * creates entities/relationships/domain links, and marks them processed.
 *
 * Call this when an ANTHROPIC_API_KEY becomes available, or on a schedule.
 */

import {
  createNode,
  createEdge,
  createFactEdge,
  findEntityByName,
  getGraph,
  updateEntitySummary,
  invalidateEntitySummary,
} from "../graph.js";
import { extractFromText } from "../extraction.js";

export interface QueueProcessResult {
  processed: number;
  failed: number;
  skipped: number;
  details: Array<{
    episode_id: string;
    status: "processed" | "failed" | "skipped";
    entities_extracted?: string[];
    error?: string;
  }>;
}

/**
 * Process all unprocessed Episodes in the graph.
 * Runs LLM extraction on each, creates entities/relationships,
 * and marks the Episode as processed.
 *
 * @param limit - Max episodes to process in one batch (default 20)
 */
export async function processQueue(limit: number = 20): Promise<QueueProcessResult> {
  const g = getGraph();

  // Find unprocessed episodes
  const unprocessed = await g.query(
    `MATCH (ep:Episode)
     WHERE ep.processed = false
     RETURN ep.id AS id, ep.content AS content
     ORDER BY ep.timestamp ASC
     LIMIT $limit`,
    { params: { limit } },
  );

  if (!unprocessed.data || unprocessed.data.length === 0) {
    return { processed: 0, failed: 0, skipped: 0, details: [] };
  }

  const result: QueueProcessResult = {
    processed: 0,
    failed: 0,
    skipped: 0,
    details: [],
  };

  for (const row of unprocessed.data as Record<string, unknown>[]) {
    const episodeId = row.id as string;
    const content = row.content as string;

    try {
      // Run extraction
      const extraction = await extractFromText(content);

      // If extraction is still queued (no API key), skip this episode
      if ("queued" in extraction && extraction.queued) {
        result.skipped++;
        result.details.push({ episode_id: episodeId, status: "skipped" });
        continue;
      }

      const now = Date.now();
      const entityIds: Record<string, string> = {};

      // Create/find entities — matches retain.ts: prefer entity_actions, apply action intents
      const entityList = extraction.entity_actions ?? extraction.entities.map((e) => ({
        ...e,
        fact_summary: "",
        action: "ADD" as const,
      }));

      for (const entity of entityList) {
        const searchName = entity.canonical_name || entity.name;
        const existing = await findEntityByName(searchName);

        if (existing) {
          entityIds[entity.name] = existing.id;

          // Apply action intent
          if ("action" in entity) {
            if (entity.action === "UPDATE" && entity.fact_summary) {
              await updateEntitySummary(existing.id, entity.fact_summary);
            } else if (entity.action === "INVALIDATE") {
              await invalidateEntitySummary(existing.id);
            }
            // ADD for existing entity = no-op
          }
        } else {
          // New entity — use fact_summary (not content.slice(0, 100))
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
          });
          entityIds[entity.name] = newId;
        }

        // Link entity to episode via "involves"
        await createEdge(
          "Episode",
          episodeId,
          "Entity",
          entityIds[entity.name],
          "involves",
          { source_episode_id: episodeId },
        );
      }

      // Create fact-bearing edges if available (Graphiti pattern)
      if (extraction.facts && extraction.facts.length > 0) {
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
            );
          }
        }
      }

      // Fallback: plain edges from relationships[] when no facts[]
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

      // Find the linked Thought and update its confidence
      const thoughtResult = await g.query(
        `MATCH (t:Thought)-[:extracted_from]->(ep:Episode {id: $episodeId})
         RETURN t.id AS id LIMIT 1`,
        { params: { episodeId } },
      );
      if (thoughtResult.data && thoughtResult.data.length > 0) {
        const thoughtId = (thoughtResult.data[0] as Record<string, unknown>).id as string;

        // Update thought confidence
        await g.query(
          `MATCH (t:Thought {id: $thoughtId})
           SET t.confidence = $confidence`,
          { params: { thoughtId, confidence: extraction.confidence } },
        );

        // Link thought to domain entities
        for (const domain of extraction.domains) {
          const domainEntity = await findEntityByName(domain);
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
      }

      // Mark episode as processed
      await g.query(
        `MATCH (ep:Episode {id: $episodeId})
         SET ep.processed = true`,
        { params: { episodeId } },
      );

      result.processed++;
      result.details.push({
        episode_id: episodeId,
        status: "processed",
        entities_extracted: extraction.entities.map((e) => e.name),
      });
    } catch (err: any) {
      result.failed++;
      result.details.push({
        episode_id: episodeId,
        status: "failed",
        error: err.message,
      });
    }
  }

  return result;
}
