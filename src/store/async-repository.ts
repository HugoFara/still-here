/**
 * Async repository seam. The app's default `Repository` is synchronous (node:sqlite
 * is sync). Postgres drivers are async, so a production Postgres deployment uses
 * this Promise-returning mirror instead. `toAsync` lets the existing sqlite store
 * satisfy the same interface, so callers can migrate to `AsyncRepository`
 * uniformly and then swap sqlite↔Postgres without further changes.
 */

import type {
  ContinuityStatus,
  Fix,
  Individual,
  OwnerResolution,
  Study,
} from "../domain/types.ts";
import type { EventRecord, NarrativeRecord, Repository } from "./repository.ts";

export interface AsyncRepository {
  upsertStudy(s: Study): Promise<void>;
  getStudy(id: string): Promise<Study | null>;
  listStudies(): Promise<Study[]>;

  upsertIndividual(i: Individual): Promise<void>;
  getIndividual(id: string): Promise<Individual | null>;
  listIndividuals(): Promise<Individual[]>;

  upsertFixes(fixes: Fix[]): Promise<number>;
  getFixes(individualId: string, sinceMs?: number): Promise<Fix[]>;

  saveStatus(s: ContinuityStatus): Promise<void>;
  getStatus(individualId: string): Promise<ContinuityStatus | null>;
  listStatuses(): Promise<ContinuityStatus[]>;

  setResolution(individualId: string, r: OwnerResolution | null): Promise<void>;
  getResolution(individualId: string): Promise<OwnerResolution | null>;

  saveNarrative(n: NarrativeRecord): Promise<void>;
  getNarrative(cacheKey: string): Promise<NarrativeRecord | null>;

  recordEvent(e: EventRecord): Promise<void>;
  allEvents(): Promise<EventRecord[]>;

  recordLicenseAcceptance(studyId: string, md5: string): Promise<void>;
  hasAcceptedLicense(studyId: string): Promise<boolean>;

  resetAll(): Promise<void>;
  close(): Promise<void>;
}

/** Wrap a synchronous {@link Repository} as an {@link AsyncRepository}. */
export function toAsync(repo: Repository): AsyncRepository {
  return {
    upsertStudy: async (s) => repo.upsertStudy(s),
    getStudy: async (id) => repo.getStudy(id),
    listStudies: async () => repo.listStudies(),
    upsertIndividual: async (i) => repo.upsertIndividual(i),
    getIndividual: async (id) => repo.getIndividual(id),
    listIndividuals: async () => repo.listIndividuals(),
    upsertFixes: async (f) => repo.upsertFixes(f),
    getFixes: async (id, since) => repo.getFixes(id, since),
    saveStatus: async (s) => repo.saveStatus(s),
    getStatus: async (id) => repo.getStatus(id),
    listStatuses: async () => repo.listStatuses(),
    setResolution: async (id, r) => repo.setResolution(id, r),
    getResolution: async (id) => repo.getResolution(id),
    saveNarrative: async (n) => repo.saveNarrative(n),
    getNarrative: async (k) => repo.getNarrative(k),
    recordEvent: async (e) => repo.recordEvent(e),
    allEvents: async () => repo.allEvents(),
    recordLicenseAcceptance: async (s, m) => repo.recordLicenseAcceptance(s, m),
    hasAcceptedLicense: async (s) => repo.hasAcceptedLicense(s),
    resetAll: async () => repo.resetAll(),
    close: async () => repo.close(),
  };
}
