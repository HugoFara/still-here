/**
 * Roster curation report (brief §4 deliverable): a ranked table of candidates
 * with provenance + scores, so a human can see WHY each animal was chosen and
 * sign off. Runs against the seed, deterministically, no store required:
 *   npm run curate
 */

import { buildSeed, DEMO_NOW } from "./seed.ts";
import { buildSignals, scoreCandidate } from "./scoring.ts";
import { computeStatus } from "../domain/continuity.ts";

function pct(x: number): string {
  return `${(x * 100).toFixed(0)}%`;
}

function main(): void {
  const now = DEMO_NOW;
  const seed = buildSeed(now);
  const studyById = new Map(seed.studies.map((s) => [s.id, s]));

  const rows = seed.animals.map((a) => {
    const study = studyById.get(a.individual.studyId)!;
    const signals = buildSignals(a.individual, a.fixes, study, now);
    const score = scoreCandidate(signals);
    const status = computeStatus({
      individualId: a.individual.id,
      now,
      expectedFixesPerWeek: a.individual.expectedFixesPerWeek,
      fixes: a.fixes,
      ownerResolution: a.ownerResolution ?? null,
      apiPermission: a.permissionLost ? "denied" : "ok",
    });
    return { a, study, score, status };
  });

  rows.sort((x, y) => {
    if (x.score.liveEligible !== y.score.liveEligible) return x.score.liveEligible ? -1 : 1;
    return y.score.score - x.score.score;
  });

  console.log("\nCURATED ROSTER (REAL Movebank tracks — provenance UNVERIFIED, confirm PI/license on Movebank)\n");
  console.log(
    "  rank  name        species                 state             score  ind/prox/leg/cad   live",
  );
  console.log("  " + "-".repeat(92));
  rows.forEach((r, i) => {
    const c = r.score.components;
    const comps = `${pct(c.individuation)}/${pct(c.proximity)}/${pct(c.legibility)}/${pct(c.cadence)}`;
    console.log(
      `  ${String(i + 1).padEnd(5)} ${r.a.individual.name.padEnd(11)} ` +
        `${r.a.individual.taxon.commonName.padEnd(23)} ${r.status.state.padEnd(17)} ` +
        `${r.score.score.toFixed(3)}  ${comps.padEnd(18)} ${r.score.liveEligible ? "yes" : "no"}`,
    );
  });

  console.log("\nProvenance (must be verified before any real deployment):");
  for (const r of rows) {
    const p = r.study.provenance;
    console.log(
      `  · ${r.a.individual.name}: study=${p.studyName} | PI=${p.principalInvestigator} | ` +
        `license=${p.license} | verified=${p.verified}`,
    );
  }
  console.log(
    "\nNote: PERMISSION_LOST animals are scored here for transparency but are hidden from the live roster.\n",
  );
}

main();
