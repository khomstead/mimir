/**
 * Ingestion classification — Mimir SERVICE trust-boundary re-check (Sprint G1).
 *
 * Spec (gobot repo): docs/superpowers/specs/2026-06-17-consent-ingestion-gate-spec.md.
 *
 * "The daemon classifies, the service enforces." The gobot daemon runs the
 * authoritative, roster-aware, org-designation-aware classification before it
 * POSTs to /api/retain. THIS module is the INDEPENDENT re-check at the wire, so
 * a direct HTTP caller who skips the daemon cannot slip minor data past the
 * gate. It is deliberately a separate implementation from the gobot module —
 * a trust boundary that shared code with the thing it's guarding wouldn't be
 * one.
 *
 * The service cannot see the org roster or the org's school-official
 * designation (those live in Convex). So it applies a COARSE, fail-closed rule:
 * content bearing a STRONG minor-PII marker is BLOCKED, unconditionally. Weak
 * "school-population" signals (the bare word "student") are the daemon's job —
 * they need org context the service lacks, and blocking on them here would
 * reject legitimate daemon-forwarded school-operations chatter.
 *
 * ⚠️ SYNC: CLASSIFICATION_VERSION mirrors the gobot config module
 * (convex/lib/ingestionClassification.ts). When the marker set changes, bump
 * BOTH and keep the strong-marker list aligned. A mismatch in the logs is the
 * drift tripwire. (No shared package across the repo boundary — intentional
 * for the trust boundary; the cost is manual sync.)
 *
 * ⚠️ FUTURE: once org_data_agreements designations exist, a daemon MAY allow
 * strong-minor content under a covering designation. This coarse block would
 * then wrongly reject it. At that point the service must gain designation
 * awareness (a Convex read or a signed "cleared" token from the daemon). Until
 * then (no designations exist), the daemon never allows strong-minor content,
 * so this block and the daemon agree. Tracked as a follow-up.
 */

export const CLASSIFICATION_VERSION = "2026-07-06.1";

/**
 * STRONG minor-PII markers — identifiable-minor shapes, not merely
 * "the topic is school." Mirror of the gobot module's STRONG_MINOR_MARKERS.
 */
const STRONG_MINOR_MARKERS: RegExp[] = [
  /\bIEP\b/i,
  /\b504\s*plan\b/i,
  /\b(my|their|his|her)\s+(son|daughter|child|kid)\b/i,
  /\b(1[0-7]|[1-9])\s*(?:years?|yrs?)\s*old\b/i,
  /\bage[:\s]*(1[0-7]|[1-9])\b/i,
  /\b(grade|gr\.?)\s*(1[0-2]|[1-9])\b/i,
  /\b(9th|10th|11th|12th|ninth|tenth|eleventh|twelfth)\s*grade(?:r)?\b/i,
  /\bdate\s+of\s+birth\b|\bDOB\b/i,
  /\bguardian\b/i,
];

/** Sources that are inherently minor-authored / minor-subject. */
const MINOR_SOURCES = new Set([
  "student",
  "kiosk",
  "school-kiosk",
  "school-observation",
  "observation",
]);

export interface ServiceGateResult {
  /** True → the service must refuse the retain (403), never call retain(). */
  blocked: boolean;
  recordClass: "minor-pii" | "unknown";
  minorContext: boolean;
  subjectHints: string[];
  confidence: number;
  reason: string;
  version: string;
}

/**
 * Coarse, fail-closed service-side gate. Returns `blocked:true` when the
 * content bears a strong minor-PII marker or arrives from a minor-subject
 * source. Otherwise passes (the daemon is the nuanced layer).
 */
export function evaluateServiceGate(
  content: string,
  source: string = "",
): ServiceGateResult {
  const raw = (content ?? "").trim();
  const src = (source ?? "").toLowerCase();
  const subjectHints: string[] = [];

  // Empty content can't be classified — but an empty retain is harmless (no
  // minor data), and the retain verb already rejects missing content. Pass.
  if (raw.length === 0) {
    return {
      blocked: false,
      recordClass: "unknown",
      minorContext: false,
      subjectHints: [],
      confidence: 0,
      reason: "empty content",
      version: CLASSIFICATION_VERSION,
    };
  }

  if (MINOR_SOURCES.has(src)) {
    return {
      blocked: true,
      recordClass: "minor-pii",
      minorContext: true,
      subjectHints: [`source:${src}`],
      confidence: 0.85,
      reason: `minor-subject source (${src}) — service trust boundary block`,
      version: CLASSIFICATION_VERSION,
    };
  }

  for (const re of STRONG_MINOR_MARKERS) {
    const m = raw.match(re);
    if (m) subjectHints.push(m[0]);
  }
  if (subjectHints.length > 0) {
    return {
      blocked: true,
      recordClass: "minor-pii",
      minorContext: true,
      subjectHints,
      confidence: 0.9,
      reason:
        "strong minor-PII marker present — service trust boundary block " +
        `(${subjectHints.slice(0, 3).join(", ")})`,
      version: CLASSIFICATION_VERSION,
    };
  }

  return {
    blocked: false,
    recordClass: "unknown",
    minorContext: false,
    subjectHints: [],
    confidence: 0,
    reason: "no strong minor-PII marker",
    version: CLASSIFICATION_VERSION,
  };
}
