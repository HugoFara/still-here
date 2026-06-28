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
import {
  buildHandoffBridge,
  describeConnection,
  pickSuccessor,
  type SuccessorCandidate,
  type SuccessorConnection,
} from "../roster/successor.ts";
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
    /** Epoch ms per point, aligned 1:1 with `points` — drives the time scrubber. */
    times: number[];
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
  /**
   * The successor handoff — the differentiator. Carries a GROUNDED bridge so the
   * relationship transfers ("another White Stork, on the same flyway"), not just
   * a name. Present only at a resolution (offerSuccessor).
   */
  successor: {
    id: string;
    name: string;
    species: string;
    /** One grounded sentence linking the resolved animal to this successor. */
    bridge: string;
    connection: SuccessorConnection;
  } | null;
  /**
   * When the follower arrived here from a resolved animal's handoff, the animal
   * they came from — so the view can acknowledge the thread instead of severing
   * it. The continuity of attachment made literal (brief §5).
   */
  continuedFrom: { id: string; name: string; species: string } | null;
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
        state: status?.state,
      });
    }
    return out;
  }

  /** Full follow-view payload. Records a 'view' (and 'action_shown' if shown).
   *  `fromId` is set when the follower arrived via a handoff, so the view can
   *  acknowledge the thread it is continuing. */
  async getAnimal(
    id: string,
    sessionId: string,
    now: number,
    fromId?: string | null,
  ): Promise<AnimalPayload | null> {
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
      // Real-but-unverified ≠ synthetic. Only a demo placeholder is synthetic.
      dataIsSynthetic: ind.synthetic ?? false,
    };
    const packet = buildGroundingPacket(ind, fixes, status, ctx);
    const gen = await this.generator.generate(ind, fixes, status, ctx);

    // Successor handoff for resolutions — picked, then GROUNDED with a real
    // connection so attachment transfers rather than evaporating.
    let successor: Individual | null = null;
    let connection: SuccessorConnection | null = null;
    if (status.directives.offerSuccessor) {
      successor = pickSuccessor(ind, "european-migratory-bird", this.successorCandidates(now));
      if (successor) {
        const succStatus = this.repo.getStatus(successor.id);
        connection = describeConnection(
          ind,
          fixes,
          successor,
          this.repo.getFixes(successor.id),
          succStatus?.state ?? "LIVE",
        );
      }
    }

    const action = chooseAction(ind, status, packet, { successor, connection });

    // One downsample, shared by the polyline and the time scrubber, so points and
    // their timestamps stay aligned 1:1.
    const sampled = downsample(fixes, 140);

    // The animal this follower was handed from, named so the view can carry the
    // thread. Never a retired animal (resolutions are visible by design).
    let continuedFrom: AnimalPayload["continuedFrom"] = null;
    if (fromId && fromId !== id) {
      const from = this.repo.getIndividual(fromId);
      if (from) {
        continuedFrom = { id: from.id, name: from.name, species: from.taxon.commonName };
      }
    }

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
        dataIsSynthetic: ind.synthetic ?? false,
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
        points: sampled.map((f) => [f.lon, f.lat]),
        times: sampled.map((f) => f.timestamp),
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
      successor:
        successor && connection
          ? {
              id: successor.id,
              name: successor.name,
              species: successor.taxon.commonName,
              bridge: buildHandoffBridge(ind.name, successor, connection),
              connection,
            }
          : null,
      continuedFrom,
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
