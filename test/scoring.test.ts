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

test("on the real roster, proximity scoring is monotonic in distance to Geneva", () => {
  const seed = buildSeed(NOW);
  const studyById = new Map(seed.studies.map((s) => [s.id, s]));
  const scored = seed.animals
    .filter((a) => !a.permissionLost) // permission-lost never reaches the roster
    .map((a) => {
      const study = studyById.get(a.individual.studyId)!;
      const signals = buildSignals(a.individual, a.fixes, study, NOW, GENEVA);
      return { id: a.individual.id, dist: signals.minDistanceKmToReference, score: scoreCandidate(signals) };
    })
    .sort((x, y) => x.dist - y.dist);

  // Closer animals never score lower on proximity than farther ones (the
  // distance-collapse formula, validated on real European tracks).
  for (let i = 1; i < scored.length; i++) {
    assert.ok(
      scored[i - 1]!.score.components.proximity >= scored[i]!.score.components.proximity,
      `proximity non-increasing with distance (${scored[i - 1]!.id} vs ${scored[i]!.id})`,
    );
  }
  // Real, fully-public studies are never hard-gated out.
  for (const s of scored) assert.equal(s.score.excluded, false, `${s.id} should not be excluded`);
});
