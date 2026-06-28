/**
 * Ingestion worker (brief §3, §8.2). For each roster individual: pull recent
 * locations through the MovebankClient, upsert fixes, recompute continuity
 * status, and (re)generate + cache the narrative. Designed to run a few times a
 * day, not in realtime.
 *
 * The §2.3 invariant is realized here: a PermissionDeniedError from the client
 * sets apiPermission='denied' → the continuity machine returns PERMISSION_LOST →
 * the animal retires silently. A genuinely quiet tag returns [] and flows to
 * QUIET / RESOLVED_UNKNOWN instead. The two are never conflated.
 */

import { computeStatus } from "../domain/continuity.ts";
import {
  LicenseTermsRequiredError,
  PermissionDeniedError,
} from "../movebank/errors.ts";
import type { MovebankClient } from "../movebank/client.ts";
import type { NarrativeGenerator } from "../narrative/generator.ts";
import type { Repository } from "../store/repository.ts";
import type { ContinuityStatus, Individual } from "../domain/types.ts";

export interface IngestSummary {
  individualId: string;
  state: ContinuityStatus["state"];
  newFixes: number;
  apiPermission: "ok" | "denied";
  narrative: "generated" | "cached" | "skipped";
  note?: string;
}

export class IngestionWorker {
  private readonly repo: Repository;
  private readonly client: MovebankClient;
  private readonly generator: NarrativeGenerator;
  /** Bound each live read to the last N ms, so a recurring poll never re-pulls
   *  years of history (a real study individual can have >500k fixes). Undefined
   *  = unbounded (the offline fixture path, where the transport ignores it). */
  private readonly lookbackMs: number | undefined;

  constructor(
    repo: Repository,
    client: MovebankClient,
    generator: NarrativeGenerator,
    opts: { lookbackMs?: number } = {},
  ) {
    this.repo = repo;
    this.client = client;
    this.generator = generator;
    this.lookbackMs = opts.lookbackMs;
  }

  /** Ingest one individual. `now` is injected for deterministic status. */
  async ingestIndividual(individual: Individual, now: number): Promise<IngestSummary> {
    let apiPermission: "ok" | "denied" = "ok";
    let note: string | undefined;
    let newFixes = 0;

    try {
      const args: Parameters<MovebankClient["getLocations"]>[0] = {
        studyId: individual.studyId,
        individualId: individual.id,
        localIdentifier: individual.localIdentifier,
      };
      // Public-JSON expects a millisecond-epoch timestamp_start; bound the window.
      if (this.lookbackMs !== undefined) args.start = String(now - this.lookbackMs);
      const fixes = await this.client.getLocations(args);
      newFixes = this.repo.upsertFixes(fixes);
    } catch (err) {
      if (err instanceof PermissionDeniedError) {
        // Permission lost — NOT tag death. Retire silently downstream.
        apiPermission = "denied";
        note = "permission denied; retiring silently";
      } else if (err instanceof LicenseTermsRequiredError) {
        // Cannot download until a human accepts terms. No new data, not a loss.
        note = "license acceptance required; skipped fetch";
      } else {
        throw err;
      }
    }

    const allFixes = this.repo.getFixes(individual.id);
    const resolution = this.repo.getResolution(individual.id);

    const status = computeStatus({
      individualId: individual.id,
      now,
      expectedFixesPerWeek: individual.expectedFixesPerWeek,
      fixes: allFixes,
      ownerResolution: resolution,
      apiPermission,
    });
    this.repo.saveStatus(status);

    // No narrative for a silently-retired animal (it never surfaces).
    let narrative: IngestSummary["narrative"] = "skipped";
    if (!status.directives.retire) {
      const study = this.repo.getStudy(individual.studyId);
      const gen = await this.generator.generate(individual, allFixes, status, {
        now,
        studyName: study?.name ?? individual.studyId,
        principalInvestigator: study?.provenance.principalInvestigator,
        provenanceVerified: study?.provenance.verified ?? false,
        // Real-but-unverified data is NOT synthetic; only a hand-built demo
        // placeholder is. Keep the two distinct so real positions are never
        // mislabelled "demo".
        dataIsSynthetic: individual.synthetic ?? false,
      });
      narrative = gen.cached ? "cached" : "generated";
    }

    const summary: IngestSummary = {
      individualId: individual.id,
      state: status.state,
      newFixes,
      apiPermission,
      narrative,
    };
    if (note) summary.note = note;
    return summary;
  }

  /**
   * Ingest every individual in the store. Resilient: one individual failing
   * (e.g. an unreachable study during a live run) is recorded and skipped rather
   * than aborting the whole batch.
   */
  async run(now: number): Promise<IngestSummary[]> {
    const out: IngestSummary[] = [];
    for (const ind of this.repo.listIndividuals()) {
      try {
        out.push(await this.ingestIndividual(ind, now));
      } catch (err) {
        const status = this.repo.getStatus(ind.id);
        out.push({
          individualId: ind.id,
          state: status?.state ?? "RESOLVED_UNKNOWN",
          newFixes: 0,
          apiPermission: "ok",
          narrative: "skipped",
          note: `ingest error, skipped: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
    return out;
  }
}
