/**
 * The continuity engine (brief §5) — the actual differentiator.
 *
 * A per-animal state machine. PURE: no I/O, no clock access, no globals. The
 * caller passes `now` and grounded inputs; the function returns a fully-formed
 * {@link ContinuityStatus} including the designed-experience {@link Directives}.
 * This makes it trivially unit-testable, which the brief demands ("the heart of
 * the product and must not be entangled with I/O").
 *
 * Design rules honored here:
 *  - Tag-death is a story beat, not a 404. Every terminal state carries
 *    directives for a designed ending + action bridge + successor handoff.
 *  - Permission-denied (API) is NEVER surfaced as the animal "disappearing".
 *    It is orthogonal to tag silence and takes top priority → retire silently.
 *  - Honesty: state is computed only from observed facts (fixes, owner data,
 *    API permission). The machine never assumes life or motion absent data.
 *  - No alarm, ever. A quiet tag is framed as resting / out of signal.
 */

import type {
  ContinuityState,
  ContinuityStatus,
  Directives,
  Fix,
  OwnerResolution,
  StatusObservation,
} from "./types.ts";

/** Tunable thresholds. Per-animal cadence flows in via `expectedFixesPerWeek`. */
export interface ContinuityConfig {
  /**
   * Multiplier on the expected inter-fix interval before we consider the animal
   * QUIET. e.g. 3 → a gap of 3× the normal spacing trips QUIET.
   */
  quietGapMultiplier: number;
  /**
   * Hard ceiling (hours) past which, with no owner resolution, we treat the
   * signal as lost → RESOLVED_UNKNOWN. Distinct from QUIET, which stays hopeful.
   */
  lostAfterHours: number;
  /** Window (hours) over which `recentFixCount` is computed for framing. */
  recentWindowHours: number;
}

export const DEFAULT_CONTINUITY_CONFIG: ContinuityConfig = {
  quietGapMultiplier: 3,
  lostAfterHours: 24 * 21, // three weeks of silence → presumed lost
  recentWindowHours: 24 * 14,
};

const HOUR_MS = 3_600_000;

/** Inputs the machine reasons over. All grounded, all explicit. */
export interface ContinuityInput {
  individualId: string;
  /** Evaluation time (epoch ms). Injected, never read from a clock here. */
  now: number;
  /** Expected fixes/week for this animal; sets the cadence baseline. */
  expectedFixesPerWeek: number;
  /**
   * Fixes for the animal. May be empty. Order does not matter — we scan for the
   * latest and count those inside the recent window. Keep this bounded upstream.
   */
  fixes: Fix[];
  /**
   * Authoritative resolution from owner/data (death, tag removed, study end).
   * When present and effective, it wins over gap-based inference.
   */
  ownerResolution?: OwnerResolution | null;
  /**
   * Result of the last data request for this animal. "denied" means the API now
   * refuses the data (permission lost) — categorically different from silence.
   */
  apiPermission?: "ok" | "denied";
  /** Optional override of when the animal entered its current state. */
  enteredAtHint?: number;
}

const DIRECTIVES: Record<ContinuityState, Directives> = {
  LIVE: {
    framing: "live",
    tone: "present",
    showAction: false,
    offerSuccessor: false,
    requestRecap: false,
    retire: false,
    alarm: false,
  },
  QUIET: {
    framing: "resting",
    tone: "soft-hopeful",
    showAction: false,
    offerSuccessor: false,
    // Keep engagement alive with a past-journey recap, not alarm.
    requestRecap: true,
    retire: false,
    alarm: false,
  },
  RESOLVED_KNOWN: {
    framing: "ending-known",
    tone: "respectful-retrospective",
    // This is the exact moment Fahlo drops the user — capture it instead.
    showAction: true,
    offerSuccessor: true,
    requestRecap: true,
    retire: false,
    alarm: false,
  },
  RESOLVED_UNKNOWN: {
    framing: "ending-unknown",
    tone: "honest-closure",
    showAction: true,
    offerSuccessor: true,
    requestRecap: true,
    retire: false,
    alarm: false,
  },
  PERMISSION_LOST: {
    framing: "retire-silently",
    tone: "none",
    showAction: false,
    offerSuccessor: false,
    requestRecap: false,
    // Quietly retire from roster; never surface as the animal disappearing.
    retire: true,
    alarm: false,
  },
};

function expectedIntervalHours(fixesPerWeek: number): number {
  // Guard against zero/garbage cadence; assume weekly if unknown.
  const perWeek = fixesPerWeek > 0 ? fixesPerWeek : 1;
  return (7 * 24) / perWeek;
}

function latestFix(fixes: Fix[]): Fix | null {
  let best: Fix | null = null;
  for (const f of fixes) {
    if (best === null || f.timestamp > best.timestamp) best = f;
  }
  return best;
}

function countWithin(fixes: Fix[], now: number, windowHours: number): number {
  const cutoff = now - windowHours * HOUR_MS;
  let n = 0;
  for (const f of fixes) if (f.timestamp >= cutoff && f.timestamp <= now) n++;
  return n;
}

/**
 * Compute continuity status for one animal. Deterministic and total: every
 * input maps to exactly one state. Priority order (highest first):
 *
 *   1. PERMISSION_LOST   — API denies data now (orthogonal to tag silence)
 *   2. RESOLVED_KNOWN    — owner/data says death | tag-removed | study-ended
 *   3. gap-based:
 *        LIVE             — last fix within quietGapMultiplier × cadence
 *        QUIET            — past that, but under lostAfterHours
 *        RESOLVED_UNKNOWN — beyond lostAfterHours (or never any fix, and old)
 */
export function computeStatus(
  input: ContinuityInput,
  config: ContinuityConfig = DEFAULT_CONTINUITY_CONFIG,
): ContinuityStatus {
  const {
    individualId,
    now,
    fixes,
    expectedFixesPerWeek,
    ownerResolution = null,
    apiPermission = "ok",
  } = input;

  const last = latestFix(fixes);
  const lastFixAt = last ? last.timestamp : null;
  const gapHours = lastFixAt === null ? null : (now - lastFixAt) / HOUR_MS;
  const recentFixCount = countWithin(fixes, now, config.recentWindowHours);

  const observed: StatusObservation = {
    lastFixAt,
    gapHours,
    recentFixCount,
    apiPermission,
    ownerResolution,
  };

  // 1. Permission lost — top priority, retire silently.
  if (apiPermission === "denied") {
    return finalize(individualId, "PERMISSION_LOST", input, observed,
      "api permission denied for this study");
  }

  // 2. Authoritative resolution from owner/data, once effective.
  if (ownerResolution && ownerResolution.at <= now) {
    return finalize(individualId, "RESOLVED_KNOWN", input, observed,
      `owner resolution: ${ownerResolution.kind}`);
  }

  // 3. Gap-based inference.
  const quietAfterHours =
    expectedIntervalHours(expectedFixesPerWeek) * config.quietGapMultiplier;

  if (gapHours === null) {
    // No fixes at all. Treat as lost-unknown (cannot honestly claim "live").
    return finalize(individualId, "RESOLVED_UNKNOWN", input, observed,
      "no fixes on record");
  }
  if (gapHours <= quietAfterHours) {
    return finalize(individualId, "LIVE", input, observed,
      `last fix ${gapHours.toFixed(1)}h ago, within ${quietAfterHours.toFixed(1)}h cadence`);
  }
  if (gapHours <= config.lostAfterHours) {
    return finalize(individualId, "QUIET", input, observed,
      `gap ${gapHours.toFixed(1)}h exceeds cadence but under lost threshold`);
  }
  return finalize(individualId, "RESOLVED_UNKNOWN", input, observed,
    `gap ${gapHours.toFixed(1)}h exceeds lost threshold ${config.lostAfterHours}h`);
}

function finalize(
  individualId: string,
  state: ContinuityState,
  input: ContinuityInput,
  observed: StatusObservation,
  rationale: string,
): ContinuityStatus {
  return {
    individualId,
    state,
    enteredAt: estimateEnteredAt(state, input, observed),
    rationale,
    observed,
    directives: DIRECTIVES[state],
  };
}

/**
 * Best-effort estimate of when the animal entered this state. Used for "X days
 * ago" framing and for not re-triggering the action bridge repeatedly. Honest:
 * falls back to `now` only when there is genuinely nothing better to anchor on.
 */
function estimateEnteredAt(
  state: ContinuityState,
  input: ContinuityInput,
  observed: StatusObservation,
): number {
  if (input.enteredAtHint !== undefined) return input.enteredAtHint;
  switch (state) {
    case "RESOLVED_KNOWN":
      return observed.ownerResolution?.at ?? input.now;
    case "QUIET":
    case "RESOLVED_UNKNOWN":
      // Entered when the last fix stopped, i.e. the start of the silence.
      return observed.lastFixAt ?? input.now;
    case "LIVE":
      return observed.lastFixAt ?? input.now;
    case "PERMISSION_LOST":
      return input.now;
  }
}

/** Convenience: is this a terminal (resolved) state that ends the story? */
export function isResolved(state: ContinuityState): boolean {
  return state === "RESOLVED_KNOWN" || state === "RESOLVED_UNKNOWN";
}
