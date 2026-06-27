/**
 * Grounding (brief §6) — PURE. Turns real fixes + status + metadata into a
 * {@link GroundingPacket}: the ONLY information any narrative provider is ever
 * given. If a fact is not in the packet, no generator can state it. This is the
 * mechanism that makes "never hallucinate events" enforceable rather than
 * aspirational. Treat any un-grounded biographical claim downstream as a bug.
 */

import {
  bearingDeg,
  compass,
  haversineKm,
  netDisplacementKm,
  pathLengthKm,
} from "../domain/geo.ts";
import { describeLocation, GAZETTEER, type PlaceDescription } from "../domain/places.ts";
import type {
  ContinuityState,
  ContinuityStatus,
  Fix,
  Individual,
  OwnerResolution,
} from "../domain/types.ts";
import { isResolved } from "../domain/continuity.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export type NarrativeKind = "update" | "recap" | "resolution";

/** Everything — and only — what a generator may speak about. */
export interface GroundingPacket {
  individualId: string;
  name: string;
  nameIsAssigned: boolean;
  species: string;
  sex: "m" | "f" | "unknown";
  state: ContinuityState;
  kind: NarrativeKind;

  latestFixAt: number | null;
  latestPlace: PlaceDescription | null;
  /** Distance/heading of the most recent leg, if there is one. */
  lastLegKm: number | null;
  lastLegHours: number | null;
  direction: string | null;
  /** Distance covered within 7 days of the latest fix. */
  movedKmLast7d: number | null;

  startPlace: PlaceDescription | null;
  totalTrackKm: number;
  netDisplacementKm: number;
  daysTracked: number;
  fixCount: number;

  /** Gap since the last fix, in days (for QUIET / resolution framing). */
  gapDays: number | null;
  ownerResolution: OwnerResolution | null;
  /** A named landmark the recent track passed near, if any. */
  landmarkCrossed: string | null;

  // Provenance / honesty surface.
  studyName: string;
  principalInvestigator: string | null;
  provenanceVerified: boolean;
  dataIsSynthetic: boolean;
}

export interface GroundingContext {
  now: number;
  studyName: string;
  principalInvestigator?: string | undefined;
  provenanceVerified: boolean;
  /** True when the track is synthetic/demo and must be labelled as such. */
  dataIsSynthetic: boolean;
}

function kindFor(state: ContinuityState): NarrativeKind {
  if (isResolved(state)) return "resolution";
  if (state === "QUIET") return "recap";
  return "update";
}

/** Detect a notable landmark the last few legs passed near (within ~70 km). */
function detectLandmark(recent: Fix[]): string | null {
  let best: { name: string; km: number } | null = null;
  for (const f of recent) {
    for (const p of GAZETTEER) {
      if (!p.landmark) continue;
      const km = haversineKm(f, p);
      if (km <= 70 && (best === null || km < best.km)) best = { name: p.name, km };
    }
  }
  return best?.name ?? null;
}

export function buildGroundingPacket(
  individual: Individual,
  fixes: Fix[],
  status: ContinuityStatus,
  ctx: GroundingContext,
): GroundingPacket {
  const sorted = [...fixes].sort((a, b) => a.timestamp - b.timestamp);
  const first = sorted[0] ?? null;
  const last = sorted[sorted.length - 1] ?? null;
  const prev = sorted.length >= 2 ? sorted[sorted.length - 2]! : null;

  const last7dStart = last ? last.timestamp - 7 * DAY : 0;
  const last7d = sorted.filter((f) => f.timestamp >= last7dStart);

  const lastLegKm = last && prev ? haversineKm(prev, last) : null;
  const lastLegHours = last && prev ? (last.timestamp - prev.timestamp) / HOUR : null;
  const direction = last && prev ? compass(bearingDeg(prev, last)) : null;

  return {
    individualId: individual.id,
    name: individual.name,
    nameIsAssigned: individual.nameIsAssigned,
    species: individual.taxon.commonName,
    sex: individual.sex ?? "unknown",
    state: status.state,
    kind: kindFor(status.state),

    latestFixAt: last ? last.timestamp : null,
    latestPlace: last ? describeLocation(last) : null,
    lastLegKm,
    lastLegHours,
    direction,
    movedKmLast7d: last ? pathLengthKm(last7d) : null,

    startPlace: first ? describeLocation(first) : null,
    totalTrackKm: pathLengthKm(sorted),
    netDisplacementKm: netDisplacementKm(sorted),
    daysTracked: first && last ? (last.timestamp - first.timestamp) / DAY : 0,
    fixCount: sorted.length,

    gapDays: status.observed.gapHours === null ? null : status.observed.gapHours / 24,
    ownerResolution: status.observed.ownerResolution,
    landmarkCrossed: detectLandmark(sorted.slice(-6)),

    studyName: ctx.studyName,
    principalInvestigator: ctx.principalInvestigator ?? null,
    provenanceVerified: ctx.provenanceVerified,
    dataIsSynthetic: ctx.dataIsSynthetic,
  };
}

/**
 * Cache key keyed to the fix batch + state + kind, so an unchanged batch reuses
 * the same narrative (cost + consistency, brief §6).
 */
export function cacheKeyFor(p: GroundingPacket): string {
  return `${p.individualId}:${p.kind}:${p.latestFixAt ?? "none"}:${p.state}`;
}
