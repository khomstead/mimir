/**
 * Mimir — Graph Model Types
 *
 * Defines the node types, edge types, and verb response types
 * for the temporal knowledge graph.
 */

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
}

export interface AnchorNode {
  id: string;
  content: string;
  domain: string;
  weight: number;
  created_at: number;
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
  processed: boolean;
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

export interface RecallResult {
  id: string;
  content: string;
  type: "thought" | "anchor" | "entity" | "episode";
  score: number;
  source: string;
  created_at: number;
  connections: string[];
  provenance: string | null;
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
}
