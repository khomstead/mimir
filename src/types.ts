/**
 * Mimir — Graph Model Types
 *
 * Defines the node types, edge types, and verb response types
 * for the temporal knowledge graph.
 */

// ─── Multi-tenancy (Phase 1E) ────────────────────────────────

/**
 * Identifies which user (and optionally which org + folio context) owns
 * a piece of knowledge in the graph. Every Episode, Thought, Entity,
 * and Anchor is stamped with a TenantStamp at creation time. Recall
 * queries are scoped to a caller's stamp at the Cypher WHERE-clause
 * level — never post-filter, never default to a fallback user.
 *
 * Required: `userId` — the Convex `users` _id of the owner. A missing
 * userId on a request rejects at the API layer (401, when require gate
 * is enabled), and on a graph write throws (refusing the write).
 *
 * Optional:
 *   - `organizationId`: when present, scopes the node to this org. Used
 *     by recall to filter by `mosscap_sessions.activeOrgScope`. Null on
 *     legacy single-tenant data and on personal-only nodes.
 *   - `folioIds`: array of folio IDs this content references. Used by
 *     the share-revocation forget cascade — when a share to folioX is
 *     revoked, nodes the recipient retained that reference folioX get
 *     `tenant_invisible_after = now`.
 *
 * Backfill: existing nodes get `userId = GOBOT_DEFAULT_USER_ID` (Kyle)
 * via `scripts/migrate-add-tenant.ts`. `organizationId` and `folioIds`
 * remain unset on legacy nodes and are treated as "no scope filter."
 */
export interface TenantStamp {
  /** Convex `users` _id of the node owner. Required on every write. */
  userId: string;
  /** Optional org-scope context (Convex `organizations` _id). */
  organizationId?: string;
  /** Optional folio context (array of Convex `mosscap_folios` _ids). */
  folioIds?: string[];
  /**
   * Org-canon marker (Knowledge Architecture P1, 2026-06-03). When true,
   * the node is stamped `org_canon: true` so that ANY active member of
   * `organizationId` may recall it (the additive org-canon read grant in
   * applyTenantFilter / vectorSearch), not just the promoter. Set ONLY by
   * the Convex knowledge bridge for entryVisibility:"org" promotions —
   * never on ordinary org-context retains, which would leak private notes
   * to co-members. Requires `organizationId` to be set to have any effect.
   */
  orgCanon?: boolean;
}

/**
 * Tenant filter for recall queries. Filters use the caller's userId as
 * the leftmost predicate of every Cypher query — content owned by other
 * users is structurally invisible unless one of the visibility relaxations
 * is set:
 *
 *   - `includeFolioIds`: include nodes whose `folio_ids` array contains
 *     any of these IDs. Used when the caller has access to folios shared
 *     by other users (Phase 1D `folio_members`).
 *   - `activeOrgScope`: when set, additionally filter to nodes whose
 *     `tenant_org_id` matches OR is null (legacy untagged content).
 *     Implements the audit's "recall scoped by activeOrgScope" req.
 *
 * A query with NO callerUserId is REJECTED at the API layer (when the
 * require-tenant-header gate is on). The `TenantFilter` shape never
 * permits an empty/anonymous caller — that's the structural defense
 * against confused-deputy cross-tenant leaks.
 *
 * The Phase 1E sharing-semantics model is READ-PREDICATE (not clone):
 * Episodes and Thoughts live in their retainer's tenant and are
 * surfaced cross-boundary via `folio_ids` ∩ `includeFolioIds`. Entities
 * and fact-edges remain strictly per-tenant (every user gets their own
 * "Kyle Homstead" entity). At share-revoke, the caller's
 * `includeFolioIds` shrinks → cross-tenant reads stop instantly; in
 * parallel the forget cascade marks the recipient's OWN derived
 * Episodes (those they retained with folio_ids: [revokedFolioId])
 * invisible via `tenant_invisible_after`.
 */
export interface TenantFilter {
  /** Caller's userId — required. */
  callerUserId: string;
  /** Folios the caller has access to (own + shared). May be empty. */
  includeFolioIds?: string[];
  /**
   * Active org scope from `mosscap_sessions.activeOrgScope`. Knowledge
   * Architecture P1 (2026-06-03) repurposed this from a FIREWALL into a
   * SOFT-BIAS signal (grilled Q2: "a caged colleague breeds distrust").
   * When set it does TWO things — neither of which excludes the caller's
   * own content:
   *   1. UNLOCKS the additive org-canon read grant: nodes with
   *      `tenant_org_id = activeOrgScope AND org_canon = true` become
   *      readable even though they're owned by another member.
   *   2. BOOSTS (in the recall verb) org-canon + active-workspace results
   *      so they foreground — personal notes still surface, just lower.
   * It no longer hard-filters out other-org content (that firewall caged
   * the caller's own cross-org knowledge). The ownership clause remains
   * the structural cross-USER isolation boundary.
   */
  activeOrgScope?: string;
  /**
   * Active folio (the workspace the turn is happening in), if any. Subset
   * signal of includeFolioIds used by the recall verb to BOOST in-workspace
   * results (provenance tier "workspace"). Distinct from includeFolioIds
   * (the full access list — what's VISIBLE vs what's FOREGROUNDED).
   */
  activeFolioIds?: string[];
  /**
   * Human-readable name of the active org, for the provenance label
   * ("<activeOrgName> canon"). Optional — falls back to "Org canon" when
   * absent. Carried so recall output is self-describing without a Convex
   * round-trip.
   */
  activeOrgName?: string;
}

// ─── Node Types ──────────────────────────────────────────────

export type EntityType = "person" | "org" | "project" | "concept" | "domain";

export interface EntityNode {
  id: string;
  name: string;
  type: EntityType;
  summary: string;
  /** Alias names for entity dedup (advisor refinement) */
  synonyms: string[];
  created_at: number;
  updated_at: number;
  // ─── Phase 1E multi-tenancy ─────────────────────────────────
  /** Convex `users` _id of the entity owner. Required post-Phase-1E. */
  tenant_user_id: string;
  /** Optional org-scope context. */
  tenant_org_id?: string;
  /** Optional folio refs (array). Used for share-revocation forget cascade. */
  folio_ids?: string[];
  /** Phase 1E forget-cascade marker: epoch ms after which this node is invisible to its owner. */
  tenant_invisible_after?: number;
}

export type ThoughtSource =
  | "chat"
  | "voice"
  | "email"
  | "manual"
  | "meeting"
  | "distillation";

export interface ThoughtNode {
  id: string;
  content: string;
  embedding: number[];
  source: ThoughtSource;
  confidence: number;
  created_at: number;
  // ─── Phase 1E multi-tenancy ─────────────────────────────────
  tenant_user_id: string;
  tenant_org_id?: string;
  folio_ids?: string[];
  tenant_invisible_after?: number;
}

export interface AnchorNode {
  id: string;
  content: string;
  domain: string;
  weight: number;
  created_at: number;
  // ─── Phase 1E multi-tenancy ─────────────────────────────────
  tenant_user_id: string;
  tenant_org_id?: string;
  folio_ids?: string[];
  tenant_invisible_after?: number;
}

export type EpisodeSourceType =
  | "conversation"
  | "email"
  | "document"
  | "voice"
  | "meeting";

export interface EpisodeNode {
  id: string;
  content: string;
  source_type: EpisodeSourceType;
  participants: string[];
  timestamp: number;
  /** Event time (when the content actually happened). May differ from ingestion `timestamp`. */
  event_at?: number;
  processed: boolean;
  // ─── Phase 1E multi-tenancy ─────────────────────────────────
  tenant_user_id: string;
  tenant_org_id?: string;
  folio_ids?: string[];
  tenant_invisible_after?: number;
}

export interface MeetingNode {
  id: string;
  transcript: string;
  participants: string[];
  source_type: "in-person" | "video" | "phone";
  recording_url: string | null;
  duration: number;
  timestamp: number;
  processed: boolean;
}

export interface ArtifactNode {
  id: string;
  title: string;
  creator: string; // entity ID reference
  media_type: "text" | "image" | "audio" | "video" | "physical";
  asset_url: string | null;
  description: string;
  vision_analysis: string | null;
  created_at: number;
}

// ─── Belief State (Pith five-state lifecycle) ────────────────

/**
 * Tracks the epistemic status of a fact edge.
 * Modeled after Pith's cognitive governance architecture.
 *
 * asserted   → newly stored fact, not yet corroborated or challenged
 * confirmed  → higher-authority source has corroborated this fact
 * questioned → equal-authority source has offered a conflicting claim
 * weakened   → higher-authority source has contradicted this fact
 * retracted  → explicitly invalidated (forget() verb or manual review)
 *
 * Contradiction detection uses source_authority to choose the outcome:
 * new.authority > old.authority → old = weakened, new = confirmed
 * new.authority < old.authority → new = questioned
 * new.authority = old.authority → both = asserted (parallel beliefs)
 */
export type BeliefState =
  | "asserted"
  | "confirmed"
  | "questioned"
  | "weakened"
  | "retracted";

// ─── Edge Types ──────────────────────────────────────────────

export type EdgeType =
  | "relates_to"
  | "constrains"
  | "extracted_from"
  | "evolves"
  | "supersedes"
  | "involves"
  | "contributes_to"
  | "tensions_with"
  | "authored_by"
  | "scoped_to"
  | "created_by"
  | "demonstrates"
  | "discussed_in"
  | "progresses_from";

export interface TemporalEdge {
  type: EdgeType;
  created_at: number;
  valid_from: number;
  valid_until: number | null;
  confidence: number;
  source_episode_id: string | null;
  /** Full natural-language fact (Graphiti pattern). Null for structural edges. */
  fact: string | null;
  /** List of episode IDs that contributed to this edge (Graphiti provenance pattern). */
  episode_ids: string[];
  /** Epistemic status of this fact (Pith five-state lifecycle). */
  belief_state: BeliefState;
  /** Trust score for the source that created this edge (0.0–1.0). */
  source_authority: number;
}

// ─── Verb Response Types ─────────────────────────────────────

export interface RetainResponse {
  stored: boolean;
  thought_id: string;
  episode_id: string;
  entities_extracted: string[];
  connections: string[];
  tensions: Array<{
    anchor_id: string;
    anchor_content: string;
    tension_description: string;
  }>;
  extracted: {
    commitment: string | null;
    deadline: string | null;
    entity: string | null;
    action_required: boolean;
  };
  /** True when extraction was deferred (no LLM available). Episode is queued for later processing. */
  extraction_deferred?: boolean;
}

// ─── Verb Response Types: pulse ─────────────────────────────

export interface PulseResponse {
  entity_or_domain: string;
  summary: string;
  recent_thoughts: Array<{ id: string; content: string; created_at: number }>;
  active_anchors: Array<{ id: string; content: string; domain: string; weight: number }>;
  open_commitments: Array<{ thought_id: string; commitment: string; deadline: string | null }>;
  connections: Array<{ name: string; type: string; relationship: string }>;
  unresolved_tensions: Array<{ anchor_content: string; tension: string }>;
  activity_period: { from: number; to: number; thought_count: number };
}

// ─── Verb Response Types: reflect ───────────────────────────

export interface ReflectResponse {
  synthesis: string;
  patterns: Array<{
    theme: string;
    thought_ids: string[];
    frequency: number;
  }>;
  gaps: Array<{
    domain: string;
    description: string;
  }>;
  evolving_ideas: Array<{
    chain: string[];
    summary: string;
  }>;
  period: { from: number; to: number };
  thoughts_analyzed: number;
}

// ─── Verb Response Types: connect ───────────────────────────

export interface ConnectResponse {
  connected: boolean;
  source_id: string;
  target_id: string;
  edge_type: EdgeType;
  rationale: string;
}

// ─── Verb Response Types: anchor ────────────────────────────

export interface AnchorResponse {
  created: boolean;
  anchor_id: string;
  content: string;
  domain: string;
  superseded: Array<{ id: string; content: string }>;
  constrained_entities: string[];
}

// ─── Verb Response Types: triage ────────────────────────────

export interface TriageResponse {
  signal_id: string;
  priority: "high" | "medium" | "low" | "noise";
  routing: "surface_immediately" | "update_tracking" | "file_enriched" | "archive";
  related_entities: string[];
  related_anchors: string[];
  context_summary: string;
  action_required: boolean;
}

/**
 * Provenance origin of a recall result (Knowledge Architecture P1).
 * Trust comes from VISIBLE sourcing, not from caging content (grilled Q2):
 * every cross-context result is labeled so the user knows where it came from.
 */
export interface RecallOrigin {
  /**
   *   - "org_canon" — distilled org canon (org_canon node, matched the
   *     caller's activeOrgScope). Boosted + labeled "<Org> canon".
   *   - "workspace" — content from the active workspace (folio match).
   *   - "shared"    — folio-shared content the caller can read but not the
   *     active workspace.
   *   - "personal"  — the caller's own un-shared content (baseline).
   */
  tier: "org_canon" | "workspace" | "shared" | "personal";
  /** Human-readable provenance label, e.g. "LightWorks Collective canon". */
  label: string;
  orgId?: string;
  folioIds?: string[];
}

export interface RecallResult {
  id: string;
  content: string;
  type: "thought" | "anchor" | "entity" | "episode";
  score: number;
  source: string;
  created_at: number;
  connections: string[];
  provenance: string | null;
  /**
   * Provenance origin (Knowledge Architecture P1, 2026-06-03). Present when
   * the node carries tenant stamps (Thought/Episode/Anchor from recall
   * strategies). Lets the caller render "this workspace" / "your personal
   * note" / "<Org> canon" chips without a second query.
   */
  origin?: RecallOrigin;
}

export interface RecallResponse {
  results: RecallResult[];
  query: string;
  strategies_used: string[];
}

export interface ExtractionResult {
  entities: Array<{
    name: string;
    type: EntityType;
    canonical_name?: string;
  }>;
  relationships: Array<{
    from: string;
    to: string;
    type: EdgeType;
    rationale: string;
  }>;
  is_anchor: boolean;
  anchor_domain: string | null;
  commitment: string | null;
  deadline: string | null;
  confidence: number;
  domains: string[];
  /** Entity upsert intents from Mem0-style extraction (optional — new extraction path only). */
  entity_actions?: ExtractedEntityWithAction[];
  /** Fact-bearing edges from Graphiti-style extraction (optional — new extraction path only). */
  facts?: ExtractedFact[];
}

// ─── Extraction Intent Types (Mem0 + Graphiti patterns) ──────

/**
 * Action intent for an entity during extraction.
 * Ported from Mem0's ADD/UPDATE/DELETE pattern.
 * - ADD: genuinely new entity, create fresh
 * - UPDATE: entity exists, merge new info into summary
 * - INVALIDATE: entity info is contradicted, soft-delete old summary
 */
export type EntityAction = "ADD" | "UPDATE" | "INVALIDATE";

export interface ExtractedEntityWithAction {
  name: string;
  type: EntityType;
  canonical_name?: string;
  /** What the LLM knows about this entity from the current episode */
  fact_summary: string;
  /** How this entity relates to existing knowledge */
  action: EntityAction;
}

/**
 * Relationship with a natural-language fact, ported from Graphiti.
 * Edges are knowledge containers, not just structural links.
 */
export interface ExtractedFact {
  from: string;
  to: string;
  edge_type: EdgeType;
  /** Full natural-language description of the relationship */
  fact: string;
  /** When this fact became true (ISO 8601 or null if unknown) */
  valid_at: string | null;
  /** When this fact stopped being true (ISO 8601 or null if still true) */
  invalid_at: string | null;
}
