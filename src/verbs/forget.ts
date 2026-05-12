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
 * Phase 1E (multi-tenant): forget operations are scoped to the caller's
 * tenant. A user can only retract THEIR own entities + edges. Cross-user
 * forgetting is structurally impossible — the MATCH includes the
 * tenant filter, so attempts on another user's entity silently no-op.
 *
 * Usage:
 *   forget("Catherine", filter, "Retracted at user request")
 *   forget(null, filter, "Episode removed", "episode-uuid-here")
 *
 * For folio-share revocation, use the separate `forgetByShareRevocation`
 * helper (also exported) which marks the recipient's derived nodes
 * `tenant_invisible_after = now` rather than retracting facts — the
 * recipient's notes about a revoked share become invisible to them
 * but the source Episodes (owned by the sharer) remain intact.
 */

import { findEntityByName, getGraph, applyShareRevocationCascade } from "../graph.js";
import type { TenantFilter } from "../types.js";

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
 * Phase 1E: tenant-scoped. The caller can only retract their own
 * entities and edges. A `TenantFilter` is required.
 *
 * @param entityName  Name of entity to retract. Pass null to retract by episode.
 * @param filter      TenantFilter — required, identifies the caller.
 * @param reason      Human-readable reason for retraction (stored for audit).
 * @param episodeId   Episode UUID to retract. Used only when entityName is null.
 */
export async function forget(
  entityName: string | null,
  filter: TenantFilter,
  reason: string = "Explicitly forgotten",
  episodeId?: string,
): Promise<ForgetResponse> {
  if (!filter || !filter.callerUserId) {
    throw new Error(
      "forget: TenantFilter with callerUserId is required (Phase 1E).",
    );
  }
  const g = getGraph();
  const now = Date.now();

  // ── Retract by entity name ──────────────────────────────────────────────
  if (entityName) {
    // Phase 1E: findEntityByName is already tenant-scoped; the returned
    // entity (if any) is guaranteed to be in the caller's tenant.
    const entity = await findEntityByName(entityName, filter);

    if (!entity) {
      return {
        retracted: false,
        target: entityName,
        target_type: "not_found",
        edges_retracted: 0,
        reason,
      };
    }

    // Mark entity summary as retracted (prefixed, not deleted).
    // Belt-and-suspenders tenant check in the MATCH — even though
    // findEntityByName already filtered, we guard the SET path too.
    await g.query(
      `MATCH (e:Entity {id: $id})
       WHERE e.tenant_user_id = $callerUserId
       SET e.summary = '[RETRACTED] ' + e.summary,
           e.updated_at = $now`,
      {
        params: {
          id: entity.id,
          now,
          callerUserId: filter.callerUserId,
        },
      },
    );

    // Retract all fact edges TO or FROM this entity that are still active.
    // Scope to caller's tenant — same fact-edge in another user's view is untouched.
    const edgeResult = await g.query(
      `MATCH (a:Entity)-[r]-(b:Entity {id: $id})
       WHERE r.valid_until IS NULL
         AND r.belief_state <> 'retracted'
         AND r.fact IS NOT NULL
         AND r.tenant_user_id = $callerUserId
       SET r.belief_state = 'retracted',
           r.valid_until = $now
       RETURN count(r) AS retracted_count`,
      {
        params: {
          id: entity.id,
          now,
          callerUserId: filter.callerUserId,
        },
      },
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
    // Verify episode exists AND is owned by the caller (tenant gate).
    const epResult = await g.query(
      `MATCH (ep:Episode {id: $id})
       WHERE ep.tenant_user_id = $callerUserId
       RETURN ep.id AS id LIMIT 1`,
      {
        params: {
          id: episodeId,
          callerUserId: filter.callerUserId,
        },
      },
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
    // AND are in the caller's tenant. Cross-tenant fact edges referring
    // to the same Episode (if any — only possible after edge migration
    // edge cases) are NOT touched.
    const edgeResult = await g.query(
      `MATCH ()-[r]->()
       WHERE r.source_episode_id = $episodeId
         AND r.valid_until IS NULL
         AND r.belief_state <> 'retracted'
         AND r.fact IS NOT NULL
         AND r.tenant_user_id = $callerUserId
       SET r.belief_state = 'retracted',
           r.valid_until = $now
       RETURN count(r) AS retracted_count`,
      {
        params: {
          episodeId,
          now,
          callerUserId: filter.callerUserId,
        },
      },
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

// ─── Phase 1E: forget cascade for folio share revocation ──────

export interface ShareRevocationCascadeResponse {
  processed: boolean;
  folioId: string;
  revokedUserId: string;
  affected: { episodes: number; thoughts: number; entities: number };
  processedAt: number;
}

/**
 * Phase 1E forget cascade: invoked when a folio share is revoked.
 *
 * Wraps `applyShareRevocationCascade` from graph.ts with a verb-shaped
 * response. Marks the recipient's OWN nodes (Episodes/Thoughts/Entities)
 * that reference the revoked folio via `folio_ids` as
 * `tenant_invisible_after = now`. The sharer's view is UNTOUCHED —
 * Episode = ground truth, never modified by the cascade.
 *
 * Idempotent: re-running with the same args is a no-op (skips already-
 * marked-invisible nodes).
 *
 * Called by:
 *   - HTTP `POST /api/forget-cascade` from gobot's
 *     `mimirForgetCascade` Convex action, which is enqueued by
 *     `folio_members.removeMember` and retried via cron on failure.
 *
 * Security: NOT tenant-filtered by caller — this is a privileged
 * operation triggered by the server-side share revocation flow. The
 * service layer's bearer-token auth gates access; only the gobot
 * daemon (holding MIMIR_SHARED_SECRET) can invoke this.
 */
export async function forgetByShareRevocation(args: {
  folioId: string;
  revokedUserId: string;
}): Promise<ShareRevocationCascadeResponse> {
  if (!args.folioId || !args.revokedUserId) {
    throw new Error(
      "forgetByShareRevocation: folioId and revokedUserId are required",
    );
  }
  const affected = await applyShareRevocationCascade({
    folioId: args.folioId,
    revokedUserId: args.revokedUserId,
  });
  return {
    processed: true,
    folioId: args.folioId,
    revokedUserId: args.revokedUserId,
    affected,
    processedAt: Date.now(),
  };
}
