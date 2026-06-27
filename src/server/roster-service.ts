/**
 * Assembles the read-models the follow UI consumes, and records funnel events.
 * Sits above the repository; keeps the HTTP layer thin.
 *
 * PERMISSION_LOST animals are filtered out everywhere a user could see them —
 * they retire silently and are never presented as "disappeared" (brief §5).
 */

import { boundingBox, type BBox } from "../domain/geo.ts";
import { describeLocation } from "../domain/places.ts";
import { buildGroundingPacket } from "../narrative/grounding.ts";
import { buildSignals, scoreCandidate } from "../roster/scoring.ts";
import { pickSuccessor, type SuccessorCandidate } from "../roster/successor.ts";
import { assignArm, chooseAction, type Action } from "../experiment/ab.ts";
import type { NarrativeGenerator } from "../narrative/generator.ts";
import type { Repository } from "../store/repository.ts";
import type { Arm, ContinuityStatus, Fix, Individual } from "../domain/types.ts";

export interface RosterItem {
  id: string;
  name: string;
  localIdentifier: string;
  species: string;
  state: ContinuityStatus["state"];
  theme: string;
  score: number;
  liveEligible: boolean;
  latestPlace: string;
  totalKm: number;
}

export interface AnimalPayload {
  arm: Arm;
  animal: {
    id: string;
    name: string;
    localIdentifier: string;
    species: string;
    sex: Individual["sex"];
    nameIsAssigned: boolean;
  };
  provenance: {
    studyName: string;
    principalInvestigator: string | null;
    license: string;
    verified: boolean;
    citation: string | null;
    dataIsSynthetic: boolean;
  };
  status: {
    state: ContinuityStatus["state"];
    framing: string;
    gapDays: number | null;
    enteredAt: number;
  };
  /** Individuated narrative — present only in the narrative arm (control omits). */
  narrative: string | null;
  journey: {
    points: Array<[number, number]>; // [lon, lat], downsampled
    bbox: BBox | null;
    totalKm: number;
    daysTracked: number;
    fixCount: number;
    startPlace: string | null;
    latestPlace: string | null;
    latestFixAt: number | null;
    landmarkCrossed: string | null;
  };
  action: Action | null;
  successor: { id: string; name: string; species: string } | null;
}

export class RosterService {
  private readonly repo: Repository;
  private readonly generator: NarrativeGenerator;
  constructor(repo: Repository, generator: NarrativeGenerator) {
    this.repo = repo;
    this.generator = generator;
  }

  /** Animals safe to display, scored and ranked (live first, then by score). */
  listRoster(now: number): RosterItem[] {
    const items: RosterItem[] = [];
    for (const ind of this.repo.listIndividuals()) {
      const status = this.repo.getStatus(ind.id);
      if (status && status.directives.retire) continue; // PERMISSION_LOST hidden
      const study = this.repo.getStudy(ind.studyId);
      if (!study) continue;
      const fixes = this.repo.getFixes(ind.id);
      const signals = buildSignals(ind, fixes, study, now);
      const score = scoreCandidate(signals);
      const last = fixes[fixes.length - 1];
      items.push({
        id: ind.id,
        name: ind.name,
        localIdentifier: ind.localIdentifier,
        species: ind.taxon.commonName,
        state: status?.state ?? "RESOLVED_UNKNOWN",
        theme: "european-migratory-bird",
        score: Number(score.score.toFixed(3)),
        liveEligible: score.liveEligible,
        latestPlace: last ? describeLocation(last).place.name : "unknown",
        totalKm: Math.round(signals.totalTrackKm),
      });
    }
    return items.sort((a, b) => {
      if (a.liveEligible !== b.liveEligible) return a.liveEligible ? -1 : 1;
      return b.score - a.score;
    });
  }

  /** Live-eligible candidates for successor handoff. */
  private successorCandidates(now: number): SuccessorCandidate[] {
    const out: SuccessorCandidate[] = [];
    for (const ind of this.repo.listIndividuals()) {
      const status = this.repo.getStatus(ind.id);
      if (status && status.directives.retire) continue;
      const study = this.repo.getStudy(ind.studyId);
      if (!study) continue;
      const fixes = this.repo.getFixes(ind.id);
      const score = scoreCandidate(buildSignals(ind, fixes, study, now));
      out.push({
        individual: ind,
        theme: "european-migratory-bird",
        liveEligible: score.liveEligible,
        score: score.score,
      });
    }
    return out;
  }

  /** Full follow-view payload. Records a 'view' (and 'action_shown' if shown). */
  async getAnimal(id: string, sessionId: string, now: number): Promise<AnimalPayload | null> {
    const ind = this.repo.getIndividual(id);
    if (!ind) return null;
    const status = this.repo.getStatus(id);
    if (!status || status.directives.retire) return null; // never surface retired
    const study = this.repo.getStudy(ind.studyId);
    if (!study) return null;

    const fixes = this.repo.getFixes(id);
    const arm = assignArm(sessionId);

    const ctx = {
      now,
      studyName: study.name,
      principalInvestigator: study.provenance.principalInvestigator,
      provenanceVerified: study.provenance.verified,
      dataIsSynthetic: !study.provenance.verified,
    };
    const packet = buildGroundingPacket(ind, fixes, status, ctx);
    const gen = await this.generator.generate(ind, fixes, status, ctx);

    // Successor handoff for resolutions.
    let successor: Individual | null = null;
    if (status.directives.offerSuccessor) {
      successor = pickSuccessor(ind, "european-migratory-bird", this.successorCandidates(now));
    }

    const action = chooseAction(ind, status, packet, { successor });

    // Instrument: a view, plus action_shown when an action is presented.
    this.repo.recordEvent({ sessionId, individualId: id, arm, type: "view", ts: now });
    if (action) {
      this.repo.recordEvent({ sessionId, individualId: id, arm, type: "action_shown", ts: now });
    }

    return {
      arm,
      animal: {
        id: ind.id,
        name: ind.name,
        localIdentifier: ind.localIdentifier,
        species: ind.taxon.commonName,
        sex: ind.sex ?? "unknown",
        nameIsAssigned: ind.nameIsAssigned,
      },
      provenance: {
        studyName: study.name,
        principalInvestigator: study.provenance.principalInvestigator ?? null,
        license: study.provenance.license,
        verified: study.provenance.verified,
        citation: study.provenance.citation ?? null,
        dataIsSynthetic: !study.provenance.verified,
      },
      status: {
        state: status.state,
        framing: status.directives.framing,
        gapDays: status.observed.gapHours === null ? null : status.observed.gapHours / 24,
        enteredAt: status.enteredAt,
      },
      // Control arm sees no individuated narrative — that's the experiment.
      narrative: arm === "narrative" ? gen.text : null,
      journey: {
        points: downsample(fixes, 140).map((f) => [f.lon, f.lat]),
        bbox: boundingBox(fixes),
        totalKm: Math.round(packet.totalTrackKm),
        daysTracked: Math.round(packet.daysTracked),
        fixCount: packet.fixCount,
        startPlace: packet.startPlace?.place.name ?? null,
        latestPlace: packet.latestPlace?.place.name ?? null,
        latestFixAt: packet.latestFixAt,
        landmarkCrossed: packet.landmarkCrossed,
      },
      action,
      successor: successor
        ? { id: successor.id, name: successor.name, species: successor.taxon.commonName }
        : null,
    };
  }

  recordEvent(
    sessionId: string,
    individualId: string,
    type: "follow" | "engage" | "action_taken",
    now: number,
    meta?: Record<string, unknown>,
  ): Arm {
    const arm = assignArm(sessionId);
    const ev = { sessionId, individualId, arm, type, ts: now } as Parameters<
      Repository["recordEvent"]
    >[0];
    if (meta) ev.meta = meta;
    this.repo.recordEvent(ev);
    return arm;
  }
}

/** Keep first + last, sample the middle. */
function downsample(fixes: Fix[], max: number): Fix[] {
  if (fixes.length <= max) return fixes;
  const step = (fixes.length - 1) / (max - 1);
  const out: Fix[] = [];
  for (let i = 0; i < max; i++) out.push(fixes[Math.round(i * step)]!);
  return out;
}
