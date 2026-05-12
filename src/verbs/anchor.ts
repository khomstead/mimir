/**
 * Mimir — Anchor Verb
 *
 * Creates an Anchor node — a load-bearing philosophy that constrains
 * downstream work in a domain. Anchors are first-class citizens:
 * - They are never silently superseded
 * - Changing an anchor requires explicit human confirmation
 * - Old anchors get valid_until timestamps and supersedes edges
 *
 * This is the ONLY verb that deliberately creates Anchor nodes.
 * (retain may detect anchor-grade content, but only flags it.)
 */

import { getGraph, createNode, createEdge, findEntityByName } from "../graph.js";
import type { AnchorResponse, TenantStamp, TenantFilter } from "../types.js";

/**
 * Phase 1E helper: TenantStamp → TenantFilter for the same caller.
 */
function stampToFilter(t: TenantStamp): TenantFilter {
  return { callerUserId: t.userId, activeOrgScope: t.organizationId, includeFolioIds: t.folioIds };
}

/**
 * Create a new Anchor in the graph.
 *
 * Phase 1E: Anchors are per-tenant philosophies. Kyle's anchor doesn't
 * constrain Catherine's content, and vice versa. The supersession scan
 * and constrains-edge creation are both scoped to the caller's tenant.
 *
 * @param content - The philosophical statement or guiding principle
 * @param domain - Which life/work domain this constrains
 * @param tenant - TenantStamp identifying the anchor's owner.
 * @param weight - Importance weight (default 1.0)
 */
export async function anchor(
  content: string,
  domain: string,
  tenant: TenantStamp,
  weight: number = 1.0,
): Promise<AnchorResponse> {
  if (!tenant || !tenant.userId) {
    throw new Error(
      "anchor: TenantStamp with userId is required (Phase 1E).",
    );
  }
  const filter = stampToFilter(tenant);
  const g = getGraph();
  const now = Date.now();

  // 1. Check for existing anchors in this domain (caller's tenant only)
  // that might be superseded.
  const existingResult = await g.query(
    `MATCH (a:Anchor)
     WHERE toLower(a.domain) = toLower($domain)
       AND a.weight > 0
       AND a.tenant_user_id = $callerUserId
     RETURN a.id AS id, a.content AS content`,
    { params: { domain, callerUserId: tenant.userId } },
  );

  const superseded: AnchorResponse["superseded"] = [];

  // 2. Create the new Anchor (tenant-stamped)
  const anchorId = await createNode("Anchor", {
    content,
    domain,
    weight,
    created_at: now,
  }, tenant);

  // 3. Mark existing anchors as superseded (set valid_until, reduce weight)
  // Note: we don't delete old anchors — they remain for history.
  // Tenant-scoped match guards the SET path.
  if (existingResult.data && existingResult.data.length > 0) {
    for (const row of existingResult.data as Record<string, unknown>[]) {
      const oldId = row.id as string;
      const oldContent = row.content as string;

      // Create supersedes edge from new to old
      await createEdge("Anchor", anchorId, "Anchor", oldId, "supersedes", {
        valid_from: now,
        confidence: 1.0,
      });

      // Mark old anchor with reduced weight (caller's tenant only).
      await g.query(
        `MATCH (a:Anchor {id: $id})
         WHERE a.tenant_user_id = $callerUserId
         SET a.weight = 0.1, a.valid_until = $now`,
        { params: { id: oldId, now, callerUserId: tenant.userId } },
      );

      superseded.push({ id: oldId, content: oldContent });
    }
  }

  // 4. Create constrains edges to entities in this domain (caller's tenant)
  const constrainedEntities: string[] = [];

  // Find entities of type "domain" or "project" that match (tenant-scoped).
  const domainEntity = await findEntityByName(domain, filter);
  if (domainEntity) {
    await createEdge("Anchor", anchorId, "Entity", domainEntity.id, "constrains", {
      valid_from: now,
      confidence: 1.0,
    });
    constrainedEntities.push(domainEntity.name);
  }

  // Also find entities scoped to this domain — caller's tenant only.
  const scopedResult = await g.query(
    `MATCH (e:Entity)
     WHERE (e.type = 'project' OR e.type = 'domain')
       AND e.tenant_user_id = $callerUserId
     WITH e
     WHERE toLower(e.name) CONTAINS toLower($domain)
        OR toLower(e.summary) CONTAINS toLower($domain)
     RETURN e.id AS id, e.name AS name
     LIMIT 5`,
    { params: { domain, callerUserId: tenant.userId } },
  );
  if (scopedResult.data) {
    for (const row of scopedResult.data as Record<string, unknown>[]) {
      const entityId = row.id as string;
      const entityName = row.name as string;
      // Avoid duplicate constrains edges
      if (!constrainedEntities.includes(entityName)) {
        await createEdge("Anchor", anchorId, "Entity", entityId, "constrains", {
          valid_from: now,
          confidence: 1.0,
        });
        constrainedEntities.push(entityName);
      }
    }
  }

  return {
    created: true,
    anchor_id: anchorId,
    content,
    domain,
    superseded,
    constrained_entities: constrainedEntities,
  };
}
