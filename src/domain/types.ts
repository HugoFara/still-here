/**
 * Core domain vocabulary.
 *
 * Mirrors the Movebank data model (brief §2.2) and adds the product layer on
 * top of it. The atomic unit of the product is the **Individual** — one named
 * animal — never a species or a population (brief §1, individuation).
 *
 * Nothing in this file does I/O. Wire-format types live in src/movebank/types.ts.
 */

// ---------------------------------------------------------------------------
// Movebank-shaped entities
// ---------------------------------------------------------------------------

/** Sensor type of a fix. Drives expected cadence and quality interpretation. */
export type SensorType =
  | "gps"
  | "gnss"
  | "argos-doppler-shift"
  | "acceleration"
  | "unknown";

/**
 * A study: owner-managed container. Not all studies are public, and "public"
 * does not imply "reusable" (brief §2.3). License + attribution travel with it
 * everywhere it is shown.
 */
export interface Study {
  id: string;
  name: string;
  /** True only for fully-public studies. v1 roster draws only from these. */
  isPublic: boolean;
  studyType?: string;
  provenance: Provenance;
}

/**
 * Per-study legal + attribution facts. The product MUST surface and respect
 * these (brief §2.3). `licenseTermsMd5` is the hash a caller passes back to the
 * public service to accept license terms before first download.
 */
export interface Provenance {
  studyId: string;
  studyName: string;
  /** Principal investigator / data owner. People, not endpoints (brief §2.3). */
  principalInvestigator?: string;
  contact?: string;
  /** Short license label, e.g. "CC0", "CC BY-NC", "Custom — see terms". */
  license: string;
  licenseTermsUrl?: string;
  /** MD5 of the accepted license terms, for the acceptance handshake. */
  licenseTermsMd5?: string;
  citation?: string;
  doi?: string;
  /**
   * Honesty flag. Until a human verifies provenance + license against live
   * Movebank, this is false and the animal MUST NOT be presented with real
   * positions as if vetted. The seed roster ships with this false on purpose.
   */
  verified: boolean;
}

/** A taxon: genus + species. */
export interface Taxon {
  genus: string;
  species: string;
  commonName: string;
}

/**
 * One animal. The product's atomic unit. Carries individuation affordances:
 * a name (assigned if none exists, and labelled as assigned, never faked),
 * a representative image, and a home study for provenance.
 */
export interface Individual {
  id: string;
  studyId: string;
  /** Movebank local identifier, e.g. "DER AU029" or a ring number. */
  localIdentifier: string;
  taxon: Taxon;
  /** Display name shown to the user. */
  name: string;
  /** True when `name` was assigned by us (no name in reference data). */
  nameIsAssigned: boolean;
  sex?: "m" | "f" | "unknown";
  /** Representative image: ideally the individual, else a species image. */
  imageUrl?: string;
  /** True when imageUrl is a species stand-in, not this animal. */
  imageIsRepresentative?: boolean;
  /** Free-text grounded reference facts (tagging date, place, etc.). */
  referenceNotes?: string;
  /** Expected fixes-per-week, used by the continuity machine. */
  expectedFixesPerWeek: number;
  /**
   * True only for a hand-built demo placeholder whose track is fabricated (e.g.
   * the PERMISSION_LOST mechanism demonstrator, which cannot be sourced from a
   * public study). Real Movebank individuals are false. Kept DISTINCT from
   * {@link Provenance.verified}: real data can be unverified-provenance without
   * being synthetic, and the UI must never mislabel real positions as "demo".
   */
  synthetic?: boolean;
}

/** A timestamped location fix. */
export interface Fix {
  individualId: string;
  /** Epoch milliseconds (UTC). */
  timestamp: number;
  lat: number;
  lon: number;
  sensorType: SensorType;
  /** Optional quality/score where the sensor provides one. */
  quality?: number;
}

// ---------------------------------------------------------------------------
// Continuity (brief §5) — the differentiator
// ---------------------------------------------------------------------------

/**
 * Per-animal continuity state. The product never shows a raw broken state;
 * every state below has a designed experience attached via {@link Directives}.
 */
export type ContinuityState =
  | "LIVE"
  | "QUIET"
  | "RESOLVED_KNOWN"
  | "RESOLVED_UNKNOWN"
  | "PERMISSION_LOST";

/** Authoritative resolution signalled by owner/data (not inferred from gaps). */
export interface OwnerResolution {
  kind: "death" | "tag-removed" | "study-ended";
  /** Epoch ms when the resolution is effective. */
  at: number;
  /** Grounded note from owner/metadata. Never fabricated. */
  note?: string;
}

/**
 * The designed experience for a state. The state machine emits these as data;
 * the UI and narrative generator consume them. Crucially: `alarm` is always
 * false — a quiet tag is "resting / out of signal", never an error (brief §5).
 */
export interface Directives {
  /** Coarse framing the UI switches on. */
  framing:
    | "live"
    | "resting"
    | "ending-known"
    | "ending-unknown"
    | "retire-silently";
  /** Narrative tone request. */
  tone:
    | "present"
    | "soft-hopeful"
    | "respectful-retrospective"
    | "honest-closure"
    | "none";
  /** Offer the single action bridge (brief §7) at this moment. */
  showAction: boolean;
  /** Offer a successor animal to preserve the relationship pattern. */
  offerSuccessor: boolean;
  /** Ask the narrative generator for a journey recap, not a daily update. */
  requestRecap: boolean;
  /** Hide from the public roster entirely (permission lost). */
  retire: boolean;
  /** Never true. Present so the invariant is explicit and testable. */
  alarm: false;
}

/** Observed, grounded facts the state was computed from. Drives honesty. */
export interface StatusObservation {
  lastFixAt: number | null;
  gapHours: number | null;
  recentFixCount: number;
  apiPermission: "ok" | "denied";
  ownerResolution: OwnerResolution | null;
}

/** Full output of the continuity state machine for one animal. */
export interface ContinuityStatus {
  individualId: string;
  state: ContinuityState;
  /** Epoch ms the animal entered this state (best estimate). */
  enteredAt: number;
  /** Short, machine-grounded reason string for logs/debugging. */
  rationale: string;
  observed: StatusObservation;
  directives: Directives;
}

// ---------------------------------------------------------------------------
// Roster + experiment
// ---------------------------------------------------------------------------

/** A curated roster member with provenance and curation score (brief §4). */
export interface RosterEntry {
  individual: Individual;
  provenance: Provenance;
  /** 0..1 curation score from the selection pipeline. */
  score: number;
  /** Thematic group for successor handoff (e.g. "european-migratory-bird"). */
  theme: string;
  /** True once a human has signed off this entry for display. */
  approved: boolean;
}

/** A/B arm. Individuated-narrative vs plain-map control (brief §7). */
export type Arm = "narrative" | "map";

/** Funnel stages the experiment measures (brief §7). */
export type FunnelEvent =
  | "follow"
  | "view"
  | "engage" // depth signal: dwell/return/expand
  | "action_shown"
  | "action_taken";
