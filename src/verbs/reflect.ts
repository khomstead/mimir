/**
 * Mimir — Reflect Verb
 *
 * Distillation verb. Gathers recent thoughts and runs pattern detection:
 * - Recurring themes (thoughts that cluster around same entities)
 * - Evolving ideas (chains of evolves edges)
 * - Gaps (domains with anchors but no recent activity)
 * - Commitments without follow-up
 *
 * Can be called explicitly or by the scheduled distillation pipeline.
 */

import { getGraph } from "../graph.js";
import type { ReflectResponse } from "../types.js";

interface TimeRange {
  from?: number;
  to?: number;
}

/**
 * Run distillation over recent thoughts.
 *
 * @param scope - Optional domain/entity filter
 * @param timeRange - Optional temporal filter (defaults to last 7 days)
 */
export async function reflect(
  scope?: string,
  timeRange?: TimeRange,
): Promise<ReflectResponse> {
  const g = getGraph();
  const now = Date.now();
  const defaultFrom = now - 7 * 24 * 60 * 60 * 1000; // 7 days
  const from = timeRange?.from ?? defaultFrom;
  const to = timeRange?.to ?? now;

  // 1. Gather recent thoughts in the period
  let scopeFilter = "";
  const params: Record<string, unknown> = { from, to };

  if (scope) {
    scopeFilter = " AND toLower(t.content) CONTAINS toLower($scope)";
    params.scope = scope;
  }

  const thoughtsResult = await g.query(
    `MATCH (t:Thought)
     WHERE t.created_at >= $from AND t.created_at <= $to${scopeFilter}
     RETURN t.id AS id, t.content AS content, t.created_at AS created_at
     ORDER BY t.created_at DESC`,
    { params },
  );

  const thoughts = (thoughtsResult.data as Record<string, unknown>[] || []).map((row) => ({
    id: row.id as string,
    content: row.content as string,
    created_at: row.created_at as number,
  }));

  // 2. Pattern detection: find entities that appear in multiple thoughts
  const entityCounts = new Map<string, { name: string; thoughtIds: string[] }>();

  for (const thought of thoughts) {
    const entityResult = await g.query(
      `MATCH (t:Thought {id: $id})-[:extracted_from]->(ep:Episode)-[:involves]->(e:Entity)
       RETURN e.name AS name`,
      { params: { id: thought.id } },
    );
    if (entityResult.data) {
      for (const row of entityResult.data as Record<string, unknown>[]) {
        const name = row.name as string;
        const existing = entityCounts.get(name);
        if (existing) {
          existing.thoughtIds.push(thought.id);
        } else {
          entityCounts.set(name, { name, thoughtIds: [thought.id] });
        }
      }
    }
  }

  // Patterns: entities mentioned in 2+ thoughts
  const patterns: ReflectResponse["patterns"] = [];
  for (const [, entry] of entityCounts) {
    if (entry.thoughtIds.length >= 2) {
      patterns.push({
        theme: entry.name,
        thought_ids: entry.thoughtIds,
        frequency: entry.thoughtIds.length,
      });
    }
  }
  patterns.sort((a, b) => b.frequency - a.frequency);

  // 3. Evolving ideas: find chains of evolves edges
  const evolvingIdeas: ReflectResponse["evolving_ideas"] = [];
  const chainsResult = await g.query(
    `MATCH path = (t1:Thought)-[:evolves*1..5]->(t2:Thought)
     WHERE t2.created_at >= $from AND t2.created_at <= $to
     RETURN [n IN nodes(path) | n.id] AS chain,
            [n IN nodes(path) | n.content] AS contents
     LIMIT 10`,
    { params: { from, to } },
  );
  if (chainsResult.data) {
    for (const row of chainsResult.data as Record<string, unknown>[]) {
      const chain = row.chain as string[];
      const contents = row.contents as string[];
      if (chain.length >= 2) {
        evolvingIdeas.push({
          chain,
          summary: contents.map((c) => c.slice(0, 60)).join(" → "),
        });
      }
    }
  }

  // 4. Gap detection: domains with active anchors but no recent thoughts
  const gaps: ReflectResponse["gaps"] = [];
  const anchorsResult = await g.query(
    `MATCH (a:Anchor)
     WHERE a.weight > 0
     RETURN DISTINCT a.domain AS domain`,
  );
  if (anchorsResult.data) {
    for (const row of anchorsResult.data as Record<string, unknown>[]) {
      const domain = row.domain as string;
      // Check if any thoughts in this domain exist in the period
      const activityResult = await g.query(
        `MATCH (t:Thought)
         WHERE t.created_at >= $from AND t.created_at <= $to
           AND toLower(t.content) CONTAINS toLower($domain)
         RETURN count(t) AS cnt`,
        { params: { from, to, domain } },
      );
      const cnt = activityResult.data
        ? ((activityResult.data[0] as Record<string, unknown>)?.cnt as number) || 0
        : 0;
      if (cnt === 0) {
        gaps.push({
          domain,
          description: `Domain "${domain}" has active anchors but no thought activity in the period`,
        });
      }
    }
  }

  // Build synthesis summary
  const synthParts: string[] = [];
  synthParts.push(`Analyzed ${thoughts.length} thoughts from the period.`);
  if (patterns.length > 0) {
    synthParts.push(`Top themes: ${patterns.slice(0, 3).map((p) => p.theme).join(", ")}.`);
  }
  if (evolvingIdeas.length > 0) {
    synthParts.push(`${evolvingIdeas.length} evolving idea chain(s) detected.`);
  }
  if (gaps.length > 0) {
    synthParts.push(`${gaps.length} domain gap(s): ${gaps.map((g) => g.domain).join(", ")}.`);
  }

  return {
    synthesis: synthParts.join(" "),
    patterns,
    gaps,
    evolving_ideas: evolvingIdeas,
    period: { from, to },
    thoughts_analyzed: thoughts.length,
  };
}
