/**
 * Roster curation scoring (brief §4). Pure and unit-tested.
 *
 * Most Movebank individuals are bad product subjects (no name, no photo, sparse
 * fixes, dead tag, maximally distant). This ranks candidates so the human picks
 * from the top, instead of "fetch all individuals". Hard gates exclude anything
 * non-public/unlicensed; soft scores rank the rest on individuation, proximity
 * (distance-collapse), narrative legibility, and cadence.
 */

import {
  minDistanceToKm,
  netDisplacementKm,
  pathLengthKm,
  type LatLon,
} from "../domain/geo.ts";
import type { Fix, Individual, Study } from "../domain/types.ts";

/** Reference point for distance-collapse. Defaults to Geneva (the user). */
export const GENEVA: LatLon = { lat: 46.2, lon: 6.14 };

export interface CandidateSignals {
  individualId: string;
  isPublic: boolean;
  licenseOk: boolean;
  /** A real name in reference data (vs. one we'd have to assign). */
  hasRealName: boolean;
  hasImage: boolean;
  recentFixesPerWeek: number;
  daysSinceLastFix: number;
  minDistanceKmToReference: number;
  totalTrackKm: number;
  netDisplacementKm: number;
}

export interface ScoreWeights {
  individuation: number;
  proximity: number;
  legibility: number;
  cadence: number;
}

export const DEFAULT_WEIGHTS: ScoreWeights = {
  individuation: 0.3,
  proximity: 0.3,
  legibility: 0.25,
  cadence: 0.15,
};

export interface CandidateScore {
  individualId: string;
  /** 0..1. Exactly 0 when hard-gated out. */
  score: number;
  excluded: boolean;
  /** Eligible for the *live* roster (recently transmitting). */
  liveEligible: boolean;
  components: ScoreWeights;
  reasons: string[];
}

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));

/** Derive scoring signals from stored data. `now` is injected (no clock here). */
export function buildSignals(
  individual: Individual,
  fixes: Fix[],
  study: Study,
  now: number,
  ref: LatLon = GENEVA,
): CandidateSignals {
  const sorted = [...fixes].sort((a, b) => a.timestamp - b.timestamp);
  const last = sorted[sorted.length - 1];
  const DAY = 86_400_000;
  const daysSinceLastFix = last ? (now - last.timestamp) / DAY : Infinity;
  const windowStart = now - 28 * DAY;
  const recent = sorted.filter((f) => f.timestamp >= windowStart && f.timestamp <= now);
  const recentFixesPerWeek = recent.length / 4;

  return {
    individualId: individual.id,
    isPublic: study.isPublic,
    licenseOk: isLicenseUsable(study),
    hasRealName: !individual.nameIsAssigned,
    hasImage: Boolean(individual.imageUrl),
    recentFixesPerWeek,
    daysSinceLastFix,
    minDistanceKmToReference: minDistanceToKm(sorted, ref),
    totalTrackKm: pathLengthKm(sorted),
    netDisplacementKm: netDisplacementKm(sorted),
  };
}

function isLicenseUsable(study: Study): boolean {
  const lic = study.provenance.license?.trim().toLowerCase() ?? "";
  if (lic === "" || lic === "none" || lic === "all rights reserved") return false;
  return true;
}

/**
 * Score one candidate. Hard gates first (public + usable license), then a
 * weighted blend of the four soft criteria.
 */
export function scoreCandidate(
  s: CandidateSignals,
  weights: ScoreWeights = DEFAULT_WEIGHTS,
  opts: { liveWithinDays?: number } = {},
): CandidateScore {
  const reasons: string[] = [];
  const liveWithinDays = opts.liveWithinDays ?? 21;

  if (!s.isPublic) reasons.push("hard-gate: study is not fully public");
  if (!s.licenseOk) reasons.push("hard-gate: no usable license");
  const excluded = !s.isPublic || !s.licenseOk;

  // Individuation: a real name and a photo both help; baseline is the fact we
  // can always assign a respectful name.
  const individuation = clamp01(
    0.4 + (s.hasRealName ? 0.3 : 0) + (s.hasImage ? 0.3 : 0),
  );

  // Proximity: exponential distance-collapse toward the reference point.
  const proximity = clamp01(Math.exp(-s.minDistanceKmToReference / 1500));

  // Legibility: a real migration has large net displacement and is reasonably
  // directed (net/path), not a random-walk blob.
  const directedness = s.totalTrackKm > 0 ? s.netDisplacementKm / s.totalTrackKm : 0;
  const legibility = clamp01(
    0.6 * clamp01(s.netDisplacementKm / 3000) + 0.4 * clamp01(directedness),
  );

  // Cadence: 3+ usable fixes/week saturates.
  const cadence = clamp01(s.recentFixesPerWeek / 3);

  const components: ScoreWeights = { individuation, proximity, legibility, cadence };

  const liveEligible =
    s.daysSinceLastFix <= liveWithinDays && s.recentFixesPerWeek > 0;
  if (!liveEligible) {
    reasons.push(
      `not live-eligible: last fix ${
        Number.isFinite(s.daysSinceLastFix) ? Math.round(s.daysSinceLastFix) : "never"
      } days ago`,
    );
  }

  const raw =
    weights.individuation * individuation +
    weights.proximity * proximity +
    weights.legibility * legibility +
    weights.cadence * cadence;
  const wsum =
    weights.individuation + weights.proximity + weights.legibility + weights.cadence;
  const score = excluded ? 0 : clamp01(raw / (wsum || 1));

  return { individualId: s.individualId, score, excluded, liveEligible, components, reasons };
}

/** Rank candidates best-first; excluded ones sink to the bottom. */
export function rankCandidates(scores: CandidateScore[]): CandidateScore[] {
  return [...scores].sort((a, b) => {
    if (a.excluded !== b.excluded) return a.excluded ? 1 : -1;
    return b.score - a.score;
  });
}
