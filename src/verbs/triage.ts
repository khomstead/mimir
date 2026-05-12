/**
 * Mimir — Triage Verb
 *
 * External signal processing. Called when emails, messages, or other
 * external signals arrive. Routes them through the Intelligence Layer:
 *
 * 1. Identify who/what the signal is about (graph lookup)
 * 2. Enrich with relationship context
 * 3. Check for anchor relevance
 * 4. Assess priority and route
 *
 * Exposed as a verb so any agent can route external inputs through
 * the Brain's intelligence layer.
 */

import { getGraph, findEntityByName } from "../graph.js";
import { generateEmbedding } from "../embeddings.js";
import { vectorSearch } from "../graph.js";
import type { TriageResponse, TenantFilter } from "../types.js";

/**
 * Triage an external signal through the Brain.
 *
 * Phase 1E: tenant-scoped. Triage matches the signal against the
 * caller's own entities, anchors, and prior thoughts. A user can't
 * triage by reference to another user's knowledge graph.
 *
 * @param content - The signal content (email body, message text, etc.)
 * @param source - Source identifier (email address, phone number, channel name)
 * @param filter - TenantFilter identifying the caller
 * @param sourceType - Type of signal (email, message, notification, etc.)
 */
export async function triage(
  content: string,
  source: string,
  filter: TenantFilter,
  sourceType: string = "message",
): Promise<TriageResponse> {
  if (!filter || !filter.callerUserId) {
    throw new Error(
      "triage: TenantFilter with callerUserId is required (Phase 1E).",
    );
  }
  const g = getGraph();
  const callerUserId = filter.callerUserId;

  // 1. Identify entities mentioned in the signal (caller's tenant only)
  const relatedEntities: string[] = [];

  // Check if the source matches a known entity
  const sourceEntity = await findEntityByName(source, filter);
  if (sourceEntity) {
    relatedEntities.push(sourceEntity.name);
  }

  // Search for entity names mentioned in the content — caller's tenant.
  const allEntitiesResult = await g.query(
    `MATCH (e:Entity)
     WHERE e.tenant_user_id = $callerUserId
     RETURN e.name AS name
     LIMIT 100`,
    { params: { callerUserId } },
  );
  if (allEntitiesResult.data) {
    const contentLower = content.toLowerCase();
    for (const row of allEntitiesResult.data as Record<string, unknown>[]) {
      const name = row.name as string;
      if (name && contentLower.includes(name.toLowerCase()) && !relatedEntities.includes(name)) {
        relatedEntities.push(name);
      }
    }
  }

  // 2. Check for anchor relevance — caller's tenant only.
  const relatedAnchors: string[] = [];
  const anchorsResult = await g.query(
    `MATCH (a:Anchor)
     WHERE a.weight > 0
       AND a.tenant_user_id = $callerUserId
     RETURN a.id AS id, a.content AS content, a.domain AS domain`,
    { params: { callerUserId } },
  );
  if (anchorsResult.data) {
    const contentLower = content.toLowerCase();
    for (const row of anchorsResult.data as Record<string, unknown>[]) {
      const anchorContent = row.content as string;
      const domain = row.domain as string;
      // Simple relevance: does the signal mention the anchor's domain?
      if (contentLower.includes(domain.toLowerCase())) {
        relatedAnchors.push(anchorContent);
      }
    }
  }

  // 3. Find related thoughts via semantic search for context enrichment.
  // Tenant-scoped vector search.
  let contextSummary = "";
  try {
    const embedding = await generateEmbedding(content);
    const similar = await vectorSearch(embedding, 3, filter);
    if (similar.length > 0) {
      contextSummary = `Related prior knowledge: ${similar
        .map((s) => s.content.slice(0, 60))
        .join("; ")}`;
    }
  } catch {
    // Semantic search failure is non-fatal
  }

  if (!contextSummary) {
    contextSummary = relatedEntities.length > 0
      ? `Signal involves known entities: ${relatedEntities.join(", ")}`
      : "No prior context found for this signal";
  }

  // 4. Priority assessment
  let priority: TriageResponse["priority"] = "low";
  let routing: TriageResponse["routing"] = "file_enriched";
  let actionRequired = false;

  // High priority: anchor-related signals
  if (relatedAnchors.length > 0) {
    priority = "high";
    routing = "surface_immediately";
  }
  // Medium priority: involves known entities with recent activity
  else if (relatedEntities.length > 0) {
    // Check if any related entity has recent activity (caller's tenant only)
    for (const entityName of relatedEntities) {
      const entity = await findEntityByName(entityName, filter);
      if (entity) {
        const recentResult = await g.query(
          `MATCH (t:Thought)-[]->(e:Entity {id: $id})
           WHERE t.created_at >= $since
             AND t.tenant_user_id = $callerUserId
           RETURN count(t) AS cnt`,
          {
            params: {
              id: entity.id,
              since: Date.now() - 7 * 24 * 60 * 60 * 1000,
              callerUserId,
            },
          },
        );
        const cnt = recentResult.data
          ? ((recentResult.data[0] as Record<string, unknown>)?.cnt as number) || 0
          : 0;
        if (cnt > 0) {
          priority = "medium";
          routing = "update_tracking";
          break;
        }
      }
    }
  }

  // Check for action-requiring language
  if (/\b(urgent|asap|deadline|action required|please respond|follow up|confirmation needed)\b/i.test(content)) {
    if (priority === "low") priority = "medium";
    actionRequired = true;
    if (routing === "file_enriched") routing = "update_tracking";
  }

  // Noise detection: very short content with no entity matches
  if (content.length < 20 && relatedEntities.length === 0 && relatedAnchors.length === 0) {
    priority = "noise";
    routing = "archive";
  }

  return {
    signal_id: crypto.randomUUID(),
    priority,
    routing,
    related_entities: relatedEntities,
    related_anchors: relatedAnchors,
    context_summary: contextSummary,
    action_required: actionRequired,
  };
}
