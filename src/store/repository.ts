/**
 * Repository interface — the I/O boundary. The pure modules (continuity,
 * scoring, narrative grounding) never touch this; only the worker, server, and
 * roster wiring do. A different store (Postgres, etc.) can implement this
 * interface without changing anything above it.
 */

import type {
  Arm,
  ContinuityStatus,
  Fix,
  FunnelEvent,
  Individual,
  OwnerResolution,
  Study,
} from "../domain/types.ts";

/** A cached generated narrative, keyed to the fix batch it was grounded in. */
export interface NarrativeRecord {
  cacheKey: string;
  individualId: string;
  kind: "update" | "recap" | "resolution";
  text: string;
  /** Serialized grounding packet, kept for auditing the honesty constraint. */
  groundingJson: string;
  createdAt: number;
}

/** One funnel event. The unit the A/B experiment is measured on (brief §7). */
export interface EventRecord {
  sessionId: string;
  individualId: string;
  arm: Arm;
  type: FunnelEvent;
  ts: number;
  meta?: Record<string, unknown>;
}

export interface Repository {
  upsertStudy(s: Study): void;
  getStudy(id: string): Study | null;
  listStudies(): Study[];

  upsertIndividual(i: Individual): void;
  getIndividual(id: string): Individual | null;
  listIndividuals(): Individual[];

  /** Idempotent upsert keyed on (individualId, timestamp). Returns rows added. */
  upsertFixes(fixes: Fix[]): number;
  getFixes(individualId: string, sinceMs?: number): Fix[];

  saveStatus(s: ContinuityStatus): void;
  getStatus(individualId: string): ContinuityStatus | null;
  listStatuses(): ContinuityStatus[];

  /**
   * Owner-supplied resolution (death / tag-removed / study-ended). In live
   * Movebank this comes from deployment + mortality reference data; a metadata
   * sync populates it. The continuity machine reads it to reach RESOLVED_KNOWN.
   */
  setResolution(individualId: string, r: OwnerResolution | null): void;
  getResolution(individualId: string): OwnerResolution | null;

  saveNarrative(n: NarrativeRecord): void;
  getNarrative(cacheKey: string): NarrativeRecord | null;

  recordEvent(e: EventRecord): void;
  allEvents(): EventRecord[];

  recordLicenseAcceptance(studyId: string, md5: string): void;
  hasAcceptedLicense(studyId: string): boolean;

  /** Wipe all rows (used by the demo seeder so re-seeding is deterministic). */
  resetAll(): void;

  close(): void;
}
