/**
 * Successor handoff (brief §5). When an animal resolves, we preserve the
 * *relationship pattern* by offering a thematically similar next animal. Prefer
 * the same species, then the same theme; only ever offer a live-eligible one.
 * Pure.
 */

import type { Individual } from "../domain/types.ts";

export interface SuccessorCandidate {
  individual: Individual;
  theme: string;
  liveEligible: boolean;
  score: number;
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

  const rank = (c: SuccessorCandidate): number => {
    let r = c.score;
    if (c.individual.taxon.species === resolved.taxon.species) r += 2; // same species
    else if (c.theme === resolvedTheme) r += 1; // same theme
    return r;
  };

  return [...live].sort((a, b) => rank(b) - rank(a))[0]!.individual;
}
