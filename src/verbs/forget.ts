/**
 * Mimir — Forget Verb
 *
 * Retracts knowledge about a named entity or specific episode. Does NOT
 * delete source material — Episodes and Thoughts are preserved as the
 * immutable ground truth. Only derived artifacts are retracted:
 *   - Entity summaries → prefixed with [RETRACTED]
 *   - Fact edges → belief_state = "retracted", valid_until = now
 *
 * This is intentional: future re-extraction from the same Episode may yield
 * different (corrected) conclusions. The source record is the audit trail.
 *
 * Usage:
 *   forget("Catherine", "Retracted at user request")      // by entity name
 *   forget(null, "Episode removed", "episode-uuid-here") // by episode ID
 */

import { findEntityByName, getGraph } from "../graph.js";

export interface ForgetResponse {
  retracted: boolean;
  target: string;
  target_type: "entity" | "episode" | "not_found";
  edges_retracted: number;
  reason: string;
}

/**
 * Retract all knowledge derived from a named entity or episode.
 *
 * @param entityName  Name of entity to retract. Pass null to retract by episode.
 * @param reason      Human-readable reason for retraction (stored for audit).
 * @param episodeId   Episode UUID to retract. Used only when entityName is null.
 */
export async function forget(
  entityName: string | null,
  reason: string = "Explicitly forgotten",
  episodeId?: string,
): Promise<ForgetResponse> {
  const g = getGraph();
  const now = Date.now();

  // ── Retract by entity name ──────────────────────────────────────────────
  if (entityName) {
    const entity = await findEntityByName(entityName);

    if (!entity) {
      return {
        retracted: false,
        target: entityName,
        target_type: "not_found",
        edges_retracted: 0,
        reason,
      };
    }

    // Mark entity summary as retracted (prefixed, not deleted)
    await g.query(
      `MATCH (e:Entity {id: $id})
       SET e.summary = '[RETRACTED] ' + e.summary,
           e.updated_at = $now`,
      { params: { id: entity.id, now } },
    );

    // Retract all fact edges TO or FROM this entity that are still active
    const edgeResult = await g.query(
      `MATCH (a:Entity)-[r]-(b:Entity {id: $id})
       WHERE r.valid_until IS NULL
         AND r.belief_state <> 'retracted'
         AND r.fact IS NOT NULL
       SET r.belief_state = 'retracted',
           r.valid_until = $now
       RETURN count(r) AS retracted_count`,
      { params: { id: entity.id, now } },
    );

    const edgesRetracted =
      ((edgeResult.data?.[0] as Record<string, unknown>)?.retracted_count as number) ?? 0;

    return {
      retracted: true,
      target: entityName,
      target_type: "entity",
      edges_retracted: edgesRetracted,
      reason,
    };
  }

  // ── Retract by episode ID ───────────────────────────────────────────────
  if (episodeId) {
    // Verify episode exists
    const epResult = await g.query(
      `MATCH (ep:Episode {id: $id}) RETURN ep.id AS id LIMIT 1`,
      { params: { id: episodeId } },
    );

    if (!epResult.data || epResult.data.length === 0) {
      return {
        retracted: false,
        target: episodeId,
        target_type: "not_found",
        edges_retracted: 0,
        reason,
      };
    }

    // Retract all fact edges whose source_episode_id matches this episode
    const edgeResult = await g.query(
      `MATCH ()-[r]->()
       WHERE r.source_episode_id = $episodeId
         AND r.valid_until IS NULL
         AND r.belief_state <> 'retracted'
         AND r.fact IS NOT NULL
       SET r.belief_state = 'retracted',
           r.valid_until = $now
       RETURN count(r) AS retracted_count`,
      { params: { episodeId, now } },
    );

    const edgesRetracted =
      ((edgeResult.data?.[0] as Record<string, unknown>)?.retracted_count as number) ?? 0;

    return {
      retracted: true,
      target: episodeId,
      target_type: "episode",
      edges_retracted: edgesRetracted,
      reason,
    };
  }

  return {
    retracted: false,
    target: "[none]",
    target_type: "not_found",
    edges_retracted: 0,
    reason: "No entity name or episode ID provided",
  };
}
