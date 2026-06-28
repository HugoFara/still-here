/**
 * The action bridge + A/B harness + funnel (brief §7). PURE.
 *
 * Success is a BEHAVIOR, not a feeling. The chosen target behavior is
 * recruit-a-follower (diffusion): measurable in-app, drives reach, feeds the
 * dynamic-norms stretch goal. At emotional peaks we surface EXACTLY ONE action
 * (never a menu — choice overload + single-action licensing). The funnel is
 * built to answer the only question that matters: does attachment to an
 * individual animal transfer to the action, or produce warm feelings that go
 * nowhere? We assume it does NOT until the experiment shows otherwise.
 */

import type { Arm, ContinuityStatus, FunnelEvent, Individual } from "../domain/types.ts";
import type { GroundingPacket } from "../narrative/grounding.ts";
import type { SuccessorConnection } from "../roster/successor.ts";
import type { EventRecord } from "../store/repository.ts";

// ---------------------------------------------------------------------------
// A/B assignment — deterministic, stable per session, no account needed.
// ---------------------------------------------------------------------------

/** FNV-1a 32-bit. Stable across processes so an anonymous session is sticky. */
function hash32(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Assign a session to an arm. `narrative` = individuated-narrative experience;
 * `map` = plain-map control. 50/50, deterministic in the session id.
 */
export function assignArm(sessionId: string, salt = "v1"): Arm {
  return hash32(`${salt}:${sessionId}`) % 2 === 0 ? "narrative" : "map";
}

// ---------------------------------------------------------------------------
// The single action.
// ---------------------------------------------------------------------------

export interface Action {
  kind: "recruit-follower";
  /** Why this peak triggered the action. */
  reason: "milestone" | "resolution";
  /** Button label. */
  label: string;
  /** Grounded, prefilled invite text. */
  shareText: string;
  /** Who the invitee would be handed — the animal itself, or its successor. */
  targetIndividualId: string;
  targetName: string;
}

function pron(sex: Individual["sex"]): string {
  return sex === "f" ? "her" : sex === "m" ? "him" : "them";
}

/**
 * Return the single action for this moment, or null when there is no emotional
 * peak (so we are not nagging mid-journey). Peaks: a resolution (designed
 * ending), or a live milestone (a named landmark just crossed).
 */
export function chooseAction(
  individual: Individual,
  status: ContinuityStatus,
  packet: GroundingPacket,
  opts: { successor?: Individual | null; connection?: SuccessorConnection | null } = {},
): Action | null {
  // Resolution peak — the exact moment competitors drop the user. Hand off.
  if (status.directives.showAction) {
    const successor = opts.successor ?? null;
    if (successor) {
      // Carry the grounded connection into the INVITE itself — the artifact that
      // actually diffuses — so a recruited friend inherits the continuity too.
      const conn = opts.connection ?? null;
      const kin = conn && !conn.sameSpecies ? "" : `, another ${successor.taxon.commonName},`;
      const link = conn?.sharedPlace
        ? ` — picking up the same flyway near ${conn.sharedPlace}`
        : conn?.sameStudy
          ? ` — from the same study`
          : "";
      return {
        kind: "recruit-follower",
        reason: "resolution",
        label: `Follow ${successor.name} with a friend`,
        shareText: `${individual.name}'s journey came to a close. I'm following ${successor.name}${kin} next${link} — come with me?`,
        targetIndividualId: successor.id,
        targetName: successor.name,
      };
    }
    // No successor available — still invite a follower to the same story's memory.
    return {
      kind: "recruit-follower",
      reason: "resolution",
      label: `Share ${individual.name}'s journey`,
      shareText: `I followed ${individual.name}, a ${individual.taxon.commonName}, across ${Math.round(packet.totalTrackKm)} km. Worth a look?`,
      targetIndividualId: individual.id,
      targetName: individual.name,
    };
  }

  // Live milestone peak — a named landmark just crossed.
  if (status.state === "LIVE" && packet.landmarkCrossed) {
    return {
      kind: "recruit-follower",
      reason: "milestone",
      label: `Invite a friend to follow ${individual.name}`,
      shareText: `${individual.name} just reached ${packet.landmarkCrossed}. Follow ${pron(individual.sex)} live with me?`,
      targetIndividualId: individual.id,
      targetName: individual.name,
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Funnel measurement.
// ---------------------------------------------------------------------------

/** Ordered stages of the funnel (brief §7). */
export const FUNNEL_STAGES: FunnelEvent[] = [
  "follow",
  "view",
  "engage",
  "action_shown",
  "action_taken",
];

export interface ArmFunnel {
  arm: Arm;
  /** Unique sessions reaching each stage. */
  follow: number;
  view: number;
  engage: number;
  action_shown: number;
  action_taken: number;
  /** action_taken / follow — does attachment transfer to the behavior? */
  followToAction: number;
  /** action_taken / action_shown — given the ask, did they act? */
  shownToAction: number;
}

export interface FunnelReport {
  arms: ArmFunnel[];
  /**
   * Multiplicative lift of the narrative arm's followToAction over the map arm.
   * null until both arms have followers. >1 means individuation beat the map.
   */
  narrativeLiftVsMap: number | null;
}

/** Unique sessions per arm per stage, plus the conversion the experiment cares about. */
export function computeFunnel(events: EventRecord[]): FunnelReport {
  const perArm = new Map<Arm, Map<FunnelEvent, Set<string>>>();
  const ensure = (arm: Arm): Map<FunnelEvent, Set<string>> => {
    let m = perArm.get(arm);
    if (!m) {
      m = new Map(FUNNEL_STAGES.map((s) => [s, new Set<string>()]));
      perArm.set(arm, m);
    }
    return m;
  };

  for (const e of events) {
    const m = ensure(e.arm);
    m.get(e.type)?.add(e.sessionId);
  }

  const arms: ArmFunnel[] = [];
  for (const arm of ["narrative", "map"] as Arm[]) {
    const m = perArm.get(arm);
    const n = (s: FunnelEvent): number => (m?.get(s)?.size ?? 0);
    const follow = n("follow");
    const actionShown = n("action_shown");
    const actionTaken = n("action_taken");
    arms.push({
      arm,
      follow,
      view: n("view"),
      engage: n("engage"),
      action_shown: actionShown,
      action_taken: actionTaken,
      followToAction: follow > 0 ? actionTaken / follow : 0,
      shownToAction: actionShown > 0 ? actionTaken / actionShown : 0,
    });
  }

  const narrative = arms.find((a) => a.arm === "narrative")!;
  const map = arms.find((a) => a.arm === "map")!;
  const narrativeLiftVsMap =
    narrative.follow > 0 && map.follow > 0 && map.followToAction > 0
      ? narrative.followToAction / map.followToAction
      : null;

  return { arms, narrativeLiftVsMap };
}
