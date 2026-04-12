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
import type { AnchorResponse } from "../types.js";

/**
 * Create a new Anchor in the graph.
 *
 * @param content - The philosophical statement or guiding principle
 * @param domain - Which life/work domain this constrains
 * @param weight - Importance weight (default 1.0)
 */
export async function anchor(
  content: string,
  domain: string,
  weight: number = 1.0,
): Promise<AnchorResponse> {
  const g = getGraph();
  const now = Date.now();

  // 1. Check for existing anchors in this domain that might be superseded
  const existingResult = await g.query(
    `MATCH (a:Anchor)
     WHERE toLower(a.domain) = toLower($domain) AND a.weight > 0
     RETURN a.id AS id, a.content AS content`,
    { params: { domain } },
  );

  const superseded: AnchorResponse["superseded"] = [];

  // 2. Create the new Anchor
  const anchorId = await createNode("Anchor", {
    content,
    domain,
    weight,
    created_at: now,
  });

  // 3. Mark existing anchors as superseded (set valid_until, reduce weight)
  // Note: we don't delete old anchors — they remain for history
  if (existingResult.data && existingResult.data.length > 0) {
    for (const row of existingResult.data as Record<string, unknown>[]) {
      const oldId = row.id as string;
      const oldContent = row.content as string;

      // Create supersedes edge from new to old
      await createEdge("Anchor", anchorId, "Anchor", oldId, "supersedes", {
        valid_from: now,
        confidence: 1.0,
      });

      // Mark old anchor with reduced weight (not zero — it's history, not deleted)
      await g.query(
        `MATCH (a:Anchor {id: $id})
         SET a.weight = 0.1, a.valid_until = $now`,
        { params: { id: oldId, now } },
      );

      superseded.push({ id: oldId, content: oldContent });
    }
  }

  // 4. Create constrains edges to entities in this domain
  const constrainedEntities: string[] = [];

  // Find entities of type "domain" or "project" that match
  const domainEntity = await findEntityByName(domain);
  if (domainEntity) {
    await createEdge("Anchor", anchorId, "Entity", domainEntity.id, "constrains", {
      valid_from: now,
      confidence: 1.0,
    });
    constrainedEntities.push(domainEntity.name);
  }

  // Also find entities scoped to this domain
  const scopedResult = await g.query(
    `MATCH (e:Entity)
     WHERE e.type = 'project' OR e.type = 'domain'
     WITH e
     WHERE toLower(e.name) CONTAINS toLower($domain)
        OR toLower(e.summary) CONTAINS toLower($domain)
     RETURN e.id AS id, e.name AS name
     LIMIT 5`,
    { params: { domain } },
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
