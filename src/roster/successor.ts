/**
 * Successor handoff (brief §5) — the heart of the differentiator. When an animal
 * resolves, we preserve the *relationship pattern* by offering a thematically
 * similar next animal, and — crucially — we make the link CONCRETE so attachment
 * transfers rather than evaporating. Prefer the same species, then the same
 * theme; only ever offer a live-eligible one. Everything here is PURE.
 */

import { describeLocation } from "../domain/places.ts";
import type { ContinuityState, Fix, Individual } from "../domain/types.ts";

export interface SuccessorCandidate {
  individual: Individual;
  theme: string;
  liveEligible: boolean;
  score: number;
  /** Current continuity state. A genuinely LIVE bird makes a better handoff than
   *  a live-eligible-but-QUIET one, all else equal. Optional for back-compat. */
  state?: ContinuityState;
}

export function pickSuccessor(
  resolved: Individual,
  resolvedTheme: string,
  candidates: SuccessorCandidate[],
): Individual | null {
  const live = candidates.filter(
    (c) => c.liveEligible && c.individual.id !== resolved.id,
  );
  if (live.length === 0) return null;

  // Species/theme kinship dominates (gap of 1.0); among equally-kindred birds, a
  // soft (+0.5) preference for one currently on the move over one gone quiet —
  // never enough to override kinship, so a quiet stork still beats a live dove
  // for a stork's follower.
  const rank = (c: SuccessorCandidate): number => {
    let r = c.score;
    if (c.individual.taxon.species === resolved.taxon.species) r += 2; // same species
    else if (c.theme === resolvedTheme) r += 1; // same theme
    if (c.state === "LIVE") r += 0.5; // prefer a vital successor
    return r;
  };

  return [...live].sort((a, b) => rank(b) - rank(a))[0]!.individual;
}

// ---------------------------------------------------------------------------
// The handoff bridge — why THIS successor, grounded in real shared facts.
// ---------------------------------------------------------------------------

/**
 * The grounded connection between a resolved animal and its successor. Every
 * field is derived only from real data (taxon, study, fixes); nothing here is
 * invented. This is what lets the UI say "the same ground Europa crossed" and
 * mean it, instead of offering a stranger.
 */
export interface SuccessorConnection {
  /** Same biological species (genus + species) as the resolved animal. */
  sameSpecies: boolean;
  /** Drawn from the same Movebank study — the strongest provenance link. */
  sameStudy: boolean;
  /** A named place BOTH tracks pass near — grounded shared geography, if any. */
  sharedPlace: string | null;
  /** Where the successor is right now, as a grounded phrase ("near …"/"in …"). */
  successorPlace: string | null;
  /** The successor's current continuity state (always live-eligible here). */
  successorState: ContinuityState;
}

/** Named places a track comes within ~75 km of, in chronological order. */
function placesNear(fixes: Fix[]): string[] {
  const sorted = [...fixes].sort((a, b) => a.timestamp - b.timestamp);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const f of sorted) {
    const d = describeLocation(f);
    if (!d.near) continue;
    if (seen.has(d.place.name)) continue;
    seen.add(d.place.name);
    out.push(d.place.name);
  }
  return out;
}

/** Grounded phrase for where an animal's latest fix is ("near X" / "in region"). */
function latestPhrase(fixes: Fix[]): string | null {
  if (fixes.length === 0) return null;
  let last = fixes[0]!;
  for (const f of fixes) if (f.timestamp > last.timestamp) last = f;
  const d = describeLocation(last);
  return d.near ? `near ${d.place.name}` : `in ${d.place.region}`;
}

/**
 * Compute the grounded connection from the resolved animal to its successor.
 * `sharedPlace` is the MOST RECENT place on the successor's track that the
 * resolved animal also passed near — i.e. somewhere the successor is heading
 * through now that the follower has already watched, which is the strongest
 * emotional hook and is fully grounded.
 */
export function describeConnection(
  resolved: Individual,
  resolvedFixes: Fix[],
  successor: Individual,
  successorFixes: Fix[],
  successorState: ContinuityState,
): SuccessorConnection {
  const resolvedPlaces = new Set(placesNear(resolvedFixes));
  const successorChrono = placesNear(successorFixes);
  let sharedPlace: string | null = null;
  for (const name of successorChrono) {
    if (resolvedPlaces.has(name)) sharedPlace = name; // keep the latest match
  }
  return {
    sameSpecies:
      resolved.taxon.genus === successor.taxon.genus &&
      resolved.taxon.species === successor.taxon.species,
    sameStudy: resolved.studyId === successor.studyId,
    sharedPlace,
    successorPlace: latestPhrase(successorFixes),
    successorState,
  };
}

/**
 * One grounded sentence that carries the relationship forward from the resolved
 * animal to its successor. Composed only from {@link SuccessorConnection} facts —
 * it never claims a link that the data does not support. Voice matches the mock
 * narrative provider (warm, concrete, no anthropomorphism).
 */
export function buildHandoffBridge(
  resolvedName: string,
  successor: Individual,
  conn: SuccessorConnection,
): string {
  const kin = conn.sameSpecies
    ? `another ${successor.taxon.commonName}`
    : `a ${successor.taxon.commonName}`;
  const where = conn.successorPlace ? ` ${conn.successorPlace}` : "";
  const moving = conn.successorState === "LIVE" ? "still on the move" : "still reporting in";

  const links: string[] = [];
  if (conn.sameStudy) {
    links.push(`from the very same study that tracked ${resolvedName}`);
  }
  if (conn.sharedPlace && (!conn.successorPlace || !conn.successorPlace.includes(conn.sharedPlace))) {
    links.push(`over ground ${resolvedName} crossed too, near ${conn.sharedPlace}`);
  } else if (conn.sharedPlace) {
    // The successor is at a place the resolved animal also visited.
    links.push(`ground ${resolvedName} crossed too`);
  }

  let s = `${successor.name} — ${kin} — is ${moving}${where}.`;
  if (links.length > 0) {
    const joined = links.length === 1 ? links[0]! : `${links[0]!}, ${links[1]!}`;
    s += ` ${joined.charAt(0).toUpperCase()}${joined.slice(1)}.`;
  }
  return s;
}
