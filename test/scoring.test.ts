import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildSignals,
  scoreCandidate,
  rankCandidates,
  GENEVA,
  type CandidateSignals,
} from "../src/roster/scoring.ts";
import { buildSeed } from "../src/roster/seed.ts";

const NOW = Date.UTC(2026, 5, 27, 12, 0, 0);

function sig(over: Partial<CandidateSignals>): CandidateSignals {
  return {
    individualId: "x",
    isPublic: true,
    licenseOk: true,
    hasRealName: true,
    hasImage: true,
    recentFixesPerWeek: 7,
    daysSinceLastFix: 1,
    minDistanceKmToReference: 100,
    totalTrackKm: 2000,
    netDisplacementKm: 1500,
    ...over,
  };
}

test("hard gate: a non-public study is excluded with score 0", () => {
  const s = scoreCandidate(sig({ isPublic: false }));
  assert.equal(s.excluded, true);
  assert.equal(s.score, 0);
  assert.match(s.reasons.join(" "), /not fully public/);
});

test("hard gate: an unusable license is excluded", () => {
  const s = scoreCandidate(sig({ licenseOk: false }));
  assert.equal(s.excluded, true);
  assert.equal(s.score, 0);
});

test("proximity dominates: a closer animal outscores an identical distant one", () => {
  const near = scoreCandidate(sig({ minDistanceKmToReference: 50 }));
  const far = scoreCandidate(sig({ minDistanceKmToReference: 4000 }));
  assert.ok(near.score > far.score, "distance-collapse rewarded");
  assert.ok(near.components.proximity > far.components.proximity);
});

test("legibility: a directed migration beats a random-walk blob", () => {
  const migration = scoreCandidate(sig({ netDisplacementKm: 2500, totalTrackKm: 3000 }));
  const blob = scoreCandidate(sig({ netDisplacementKm: 30, totalTrackKm: 3000 }));
  assert.ok(migration.components.legibility > blob.components.legibility);
});

test("live-eligibility tracks recency, independent of score", () => {
  const live = scoreCandidate(sig({ daysSinceLastFix: 2 }));
  const stale = scoreCandidate(sig({ daysSinceLastFix: 60 }));
  assert.equal(live.liveEligible, true);
  assert.equal(stale.liveEligible, false);
  assert.match(stale.reasons.join(" "), /not live-eligible/);
});

test("ranking puts excluded candidates last", () => {
  const ranked = rankCandidates([
    scoreCandidate(sig({ individualId: "ok-low", minDistanceKmToReference: 3000 })),
    scoreCandidate(sig({ individualId: "excluded", isPublic: false })),
    scoreCandidate(sig({ individualId: "ok-high", minDistanceKmToReference: 30 })),
  ]);
  assert.equal(ranked[0]!.individualId, "ok-high");
  assert.equal(ranked[2]!.individualId, "excluded");
});

test("on real seed data, the Lake-Geneva ibis tops proximity for a Geneva user", () => {
  const seed = buildSeed(NOW);
  const studyById = new Map(seed.studies.map((s) => [s.id, s]));
  const scored = seed.animals
    .filter((a) => !a.permissionLost) // permission-lost never reaches the roster
    .map((a) => {
      const study = studyById.get(a.individual.studyId)!;
      const signals = buildSignals(a.individual, a.fixes, study, NOW, GENEVA);
      return { id: a.individual.id, score: scoreCandidate(signals) };
    });

  const tara = scored.find((x) => x.id === "ibis-tara")!;
  const others = scored.filter((x) => x.id !== "ibis-tara");
  for (const o of others) {
    assert.ok(
      tara.score.components.proximity >= o.score.components.proximity,
      `Tara should be at least as close as ${o.id}`,
    );
  }
  // And the live seed animals are not excluded.
  assert.equal(tara.score.excluded, false);
});
