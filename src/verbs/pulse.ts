/**
 * Mimir — Pulse Verb
 *
 * Status synthesis around an entity or domain. Traverses the graph
 * to build a comprehensive view:
 * - For a person: trajectory, anchors, connections, recent activity
 * - For a project: anchors, recent thoughts, commitments, gaps
 * - For a domain: cross-entity synthesis, attention patterns
 */

import { getGraph, findEntityByName } from "../graph.js";
import type { PulseResponse } from "../types.js";

/**
 * Generate a status synthesis for an entity or domain.
 *
 * @param entityOrDomain - Name of an entity or domain to pulse
 */
export async function pulse(entityOrDomain: string): Promise<PulseResponse> {
  const g = getGraph();
  const now = Date.now();
  const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;

  // Try to find as an entity first
  const entity = await findEntityByName(entityOrDomain);

  // 1. Recent thoughts connected to this entity/domain
  let recentThoughts: PulseResponse["recent_thoughts"] = [];

  if (entity) {
    // Entity-centric: find thoughts that directly connect to this entity,
    // or thoughts linked via episodes that involve this entity
    const directResult = await g.query(
      `MATCH (t:Thought)-[]->(e:Entity {id: $entityId})
       WHERE t.created_at >= $since
       RETURN DISTINCT t.id AS id, t.content AS content, t.created_at AS created_at
       ORDER BY t.created_at DESC
       LIMIT 10`,
      { params: { entityId: entity.id, since: thirtyDaysAgo } },
    );
    const viaEpisodeResult = await g.query(
      `MATCH (t:Thought)-[:extracted_from]->(ep:Episode)-[:involves]->(e:Entity {id: $entityId})
       WHERE t.created_at >= $since
       RETURN DISTINCT t.id AS id, t.content AS content, t.created_at AS created_at
       ORDER BY t.created_at DESC
       LIMIT 10`,
      { params: { entityId: entity.id, since: thirtyDaysAgo } },
    );

    // Merge and deduplicate
    const seen = new Set<string>();
    const allRows = [
      ...((directResult.data as Record<string, unknown>[]) || []),
      ...((viaEpisodeResult.data as Record<string, unknown>[]) || []),
    ];
    for (const row of allRows) {
      const id = row.id as string;
      if (!seen.has(id)) {
        seen.add(id);
        recentThoughts.push({
          id,
          content: row.content as string,
          created_at: row.created_at as number,
        });
      }
    }
    recentThoughts.sort((a, b) => b.created_at - a.created_at);
    recentThoughts = recentThoughts.slice(0, 10);
    const thoughtsResult = { data: recentThoughts }; // for compatibility below
    void thoughtsResult;
  } else {
    // Domain-centric: find thoughts that mention this domain in their Episode
    const thoughtsResult = await g.query(
      `MATCH (t:Thought)
       WHERE t.created_at >= $since
         AND toLower(t.content) CONTAINS toLower($domain)
       RETURN t.id AS id, t.content AS content, t.created_at AS created_at
       ORDER BY t.created_at DESC
       LIMIT 10`,
      { params: { domain: entityOrDomain, since: thirtyDaysAgo } },
    );
    if (thoughtsResult.data) {
      recentThoughts = (thoughtsResult.data as Record<string, unknown>[]).map((row) => ({
        id: row.id as string,
        content: row.content as string,
        created_at: row.created_at as number,
      }));
    }
  }

  // 2. Active anchors in this domain
  let activeAnchors: PulseResponse["active_anchors"] = [];
  const searchDomain = entity?.type === "domain" ? entity.name : entityOrDomain;
  const anchorsResult = await g.query(
    `MATCH (a:Anchor)
     WHERE toLower(a.domain) CONTAINS toLower($domain) AND a.weight > 0
     RETURN a.id AS id, a.content AS content, a.domain AS domain, a.weight AS weight`,
    { params: { domain: searchDomain } },
  );
  if (anchorsResult.data) {
    activeAnchors = (anchorsResult.data as Record<string, unknown>[]).map((row) => ({
      id: row.id as string,
      content: row.content as string,
      domain: row.domain as string,
      weight: row.weight as number,
    }));
  }

  // 3. Open commitments (thoughts with action_required context)
  // We look for thoughts extracted from episodes that had commitments
  // For now, search thought content for commitment-like language
  let openCommitments: PulseResponse["open_commitments"] = [];
  if (entity) {
    const commitResult = await g.query(
      `MATCH (t:Thought)-[:extracted_from]->(ep:Episode)-[:involves]->(e:Entity {id: $entityId})
       WHERE t.created_at >= $since
       RETURN t.id AS id, t.content AS content
       LIMIT 5`,
      { params: { entityId: entity.id, since: thirtyDaysAgo } },
    );
    if (commitResult.data) {
      // Filter for commitment-like content
      for (const row of commitResult.data as Record<string, unknown>[]) {
        const content = row.content as string;
        if (/\b(need to|should|must|will|commit|follow up|deadline|by \w+day)\b/i.test(content)) {
          openCommitments.push({
            thought_id: row.id as string,
            commitment: content.slice(0, 150),
            deadline: null,
          });
        }
      }
    }
  }

  // 4. Connected entities (check both directions)
  let connections: PulseResponse["connections"] = [];
  if (entity) {
    const connResult = await g.query(
      `MATCH (e:Entity {id: $entityId})-[r]->(other:Entity)
       RETURN DISTINCT other.name AS name, other.type AS type, type(r) AS relationship
       LIMIT 15`,
      { params: { entityId: entity.id } },
    );
    const connResult2 = await g.query(
      `MATCH (other:Entity)-[r]->(e:Entity {id: $entityId})
       RETURN DISTINCT other.name AS name, other.type AS type, type(r) AS relationship
       LIMIT 15`,
      { params: { entityId: entity.id } },
    );
    // Merge both directions
    const allConns = [
      ...((connResult.data as Record<string, unknown>[]) || []),
      ...((connResult2.data as Record<string, unknown>[]) || []),
    ];
    const connSeen = new Set<string>();
    for (const row of allConns) {
      const name = row.name as string;
      if (!connSeen.has(name)) {
        connSeen.add(name);
        connections.push({
          name,
          type: row.type as string,
          relationship: row.relationship as string,
        });
      }
    }
  }

  // 5. Unresolved tensions
  let unresolvedTensions: PulseResponse["unresolved_tensions"] = [];
  if (entity) {
    // Two queries: tensions from thoughts directly linked, and via episodes
    const tensionResult = await g.query(
      `MATCH (t:Thought)-[:tensions_with]->(a:Anchor),
             (t)-[]->(e:Entity {id: $entityId})
       RETURN a.content AS anchor_content, t.content AS tension
       LIMIT 5`,
      { params: { entityId: entity.id } },
    );
    if (tensionResult.data) {
      unresolvedTensions = (tensionResult.data as Record<string, unknown>[]).map((row) => ({
        anchor_content: row.anchor_content as string,
        tension: (row.tension as string)?.slice(0, 150),
      }));
    }
  }

  // 6. Activity summary — count thoughts found (already computed above)
  const thoughtCount = recentThoughts.length;
  // For a more accurate count when entity-based, also count via episodes
  let totalThoughtCount = thoughtCount;
  if (entity) {
    const cntResult = await g.query(
      `MATCH (t:Thought)-[]->(e:Entity {id: $id})
       WHERE t.created_at >= $since
       RETURN count(DISTINCT t) AS cnt`,
      { params: { id: entity.id, since: thirtyDaysAgo } },
    );
    const cntViaEp = await g.query(
      `MATCH (t:Thought)-[:extracted_from]->(ep:Episode)-[:involves]->(e:Entity {id: $id})
       WHERE t.created_at >= $since
       RETURN count(DISTINCT t) AS cnt`,
      { params: { id: entity.id, since: thirtyDaysAgo } },
    );
    const cnt1 = cntResult.data ? ((cntResult.data[0] as Record<string, unknown>)?.cnt as number) || 0 : 0;
    const cnt2 = cntViaEp.data ? ((cntViaEp.data[0] as Record<string, unknown>)?.cnt as number) || 0 : 0;
    totalThoughtCount = Math.max(cnt1, cnt2, thoughtCount);
  } else {
    const cntResult = await g.query(
      `MATCH (t:Thought)
       WHERE t.created_at >= $since AND toLower(t.content) CONTAINS toLower($id)
       RETURN count(t) AS cnt`,
      { params: { id: entityOrDomain, since: thirtyDaysAgo } },
    );
    totalThoughtCount = cntResult.data
      ? ((cntResult.data[0] as Record<string, unknown>)?.cnt as number) || 0
      : 0;
  }
  // Build summary
  const entityName = entity?.name || entityOrDomain;
  const summaryParts: string[] = [];
  summaryParts.push(`${entityName}: ${totalThoughtCount} thoughts in the last 30 days.`);
  if (activeAnchors.length > 0) {
    summaryParts.push(`${activeAnchors.length} active anchor(s).`);
  }
  if (openCommitments.length > 0) {
    summaryParts.push(`${openCommitments.length} open commitment(s).`);
  }
  if (unresolvedTensions.length > 0) {
    summaryParts.push(`${unresolvedTensions.length} unresolved tension(s).`);
  }
  if (connections.length > 0) {
    summaryParts.push(`Connected to ${connections.length} entities.`);
  }

  return {
    entity_or_domain: entityName,
    summary: summaryParts.join(" "),
    recent_thoughts: recentThoughts,
    active_anchors: activeAnchors,
    open_commitments: openCommitments,
    connections,
    unresolved_tensions: unresolvedTensions,
    activity_period: {
      from: thirtyDaysAgo,
      to: now,
      thought_count: totalThoughtCount,
    },
  };
}
