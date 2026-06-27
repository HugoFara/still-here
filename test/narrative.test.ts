import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGroundingPacket, cacheKeyFor } from "../src/narrative/grounding.ts";
import { MockLLMProvider } from "../src/llm/provider.ts";
import { NarrativeGenerator } from "../src/narrative/generator.ts";
import { computeStatus } from "../src/domain/continuity.ts";
import { buildSeed } from "../src/roster/seed.ts";
import { SqliteRepository } from "../src/store/sqlite-store.ts";
import type { Fix, Individual } from "../src/domain/types.ts";

const NOW = Date.UTC(2026, 5, 27, 12, 0, 0);
const seed = buildSeed(NOW);
const byId = new Map(seed.animals.map((a) => [a.individual.id, a]));

function statusFor(id: string) {
  const a = byId.get(id)!;
  return computeStatus({
    individualId: id,
    now: NOW,
    expectedFixesPerWeek: a.individual.expectedFixesPerWeek,
    fixes: a.fixes,
    ownerResolution: a.ownerResolution ?? null,
  });
}

const ctx = {
  now: NOW,
  studyName: "Demo Study",
  principalInvestigator: "Demo PI",
  provenanceVerified: false,
  dataIsSynthetic: true,
};

const mock = new MockLLMProvider();

test("grounding packet derives real journey facts for a live stork", () => {
  const a = byId.get("stork-aila")!;
  const p = buildGroundingPacket(a.individual, a.fixes, statusFor("stork-aila"), ctx);
  assert.equal(p.state, "LIVE");
  assert.equal(p.kind, "update");
  assert.ok(p.totalTrackKm > 1000, "stork has migrated > 1000 km");
  assert.equal(p.landmarkCrossed, "the Strait of Gibraltar", "detects the landmark crossing");
  assert.ok(p.latestPlace);
  assert.equal(p.startPlace?.place.name, "Lake Constance");
});

test("mock update is concrete, names the animal, and never leaks coordinates", async () => {
  const a = byId.get("stork-aila")!;
  const p = buildGroundingPacket(a.individual, a.fixes, statusFor("stork-aila"), ctx);
  const text = await mock.generate(p);
  assert.match(text, /Aila/);
  assert.match(text, /km/, "gives a concrete distance");
  assert.doesNotMatch(text, /lat|lon|-?\d+\.\d{3,}/, "no raw coordinates");
});

test("HONESTY: with no prior leg, the update does not fabricate a distance", async () => {
  const ind: Individual = {
    id: "solo",
    studyId: "s",
    localIdentifier: "L1",
    taxon: { genus: "Ciconia", species: "ciconia", commonName: "White Stork" },
    name: "Solo",
    nameIsAssigned: false,
    sex: "f",
    expectedFixesPerWeek: 7,
  };
  const fixes: Fix[] = [
    { individualId: "solo", timestamp: NOW - 3 * 3_600_000, lat: 46.45, lon: 6.6, sensorType: "gps" },
  ];
  const status = computeStatus({ individualId: "solo", now: NOW, expectedFixesPerWeek: 7, fixes });
  const p = buildGroundingPacket(ind, fixes, status, ctx);
  assert.equal(p.lastLegKm, null);
  const text = await mock.generate(p);
  assert.doesNotMatch(text, /\d+\s*km\s+(north|south|east|west)/, "no invented movement leg");
  assert.match(text, /stayed put|quiet/i);
});

test("QUIET reads as resting and hopeful, with no alarm language", async () => {
  const a = byId.get("stork-niko")!;
  const status = statusFor("stork-niko");
  assert.equal(status.state, "QUIET");
  const p = buildGroundingPacket(a.individual, a.fixes, status, ctx);
  const text = await mock.generate(p);
  assert.match(text, /quiet|resting/i);
  assert.doesNotMatch(text, /lost|dead|died|alarm|error|missing/i);
});

test("RESOLVED_KNOWN is a designed ending: past tense, recap, owner note, thanks", async () => {
  const a = byId.get("osprey-skylla")!;
  const status = statusFor("osprey-skylla");
  assert.equal(status.state, "RESOLVED_KNOWN");
  const p = buildGroundingPacket(a.individual, a.fixes, status, ctx);
  const text = await mock.generate(p);
  assert.match(text, /journey/i);
  assert.match(text, /recovered|deployment/i, "includes the grounded owner note");
  assert.match(text, /travelled .* km/i, "retrospective distance");
  assert.match(text, /thank you/i);
});

test("RESOLVED_UNKNOWN is honest about not knowing what happened", async () => {
  const a = byId.get("eagle-viljo")!;
  const status = statusFor("eagle-viljo");
  assert.equal(status.state, "RESOLVED_UNKNOWN");
  const p = buildGroundingPacket(a.individual, a.fixes, status, ctx);
  const text = await mock.generate(p);
  assert.match(text, /lost .*signal/i);
  assert.match(text, /won't pretend|can't|won't/i);
});

test("narratives are cached by fix batch and reused", async () => {
  const repo = SqliteRepository.open(":memory:");
  const gen = new NarrativeGenerator(mock, repo);
  const a = byId.get("stork-aila")!;
  const status = statusFor("stork-aila");

  const first = await gen.generate(a.individual, a.fixes, status, ctx);
  assert.equal(first.cached, false);
  const second = await gen.generate(a.individual, a.fixes, status, ctx);
  assert.equal(second.cached, true, "unchanged batch reuses the narrative");
  assert.equal(second.text, first.text);

  // A new fix changes the cache key → regenerate.
  const moreFixes = [
    ...a.fixes,
    { individualId: a.individual.id, timestamp: NOW + 3_600_000, lat: 35.5, lon: -5.9, sensorType: "gps" as const },
  ];
  const newStatus = computeStatus({
    individualId: a.individual.id,
    now: NOW + 3_600_000,
    expectedFixesPerWeek: 7,
    fixes: moreFixes,
  });
  const third = await gen.generate(a.individual, moreFixes, newStatus, { ...ctx, now: NOW + 3_600_000 });
  assert.equal(third.cached, false, "a new fix batch is a cache miss");
  assert.notEqual(third.cacheKey, first.cacheKey);
  repo.close();
});

test("the grounding packet exposes only whitelisted fields (no leakage channel)", () => {
  const a = byId.get("stork-aila")!;
  const p = buildGroundingPacket(a.individual, a.fixes, statusFor("stork-aila"), ctx);
  const allowed = new Set([
    "individualId", "name", "nameIsAssigned", "species", "sex", "state", "kind",
    "latestFixAt", "latestPlace", "lastLegKm", "lastLegHours", "direction", "movedKmLast7d",
    "startPlace", "totalTrackKm", "netDisplacementKm", "daysTracked", "fixCount",
    "gapDays", "ownerResolution", "landmarkCrossed",
    "studyName", "principalInvestigator", "provenanceVerified", "dataIsSynthetic",
  ]);
  for (const k of Object.keys(p)) assert.ok(allowed.has(k), `unexpected packet field: ${k}`);
  assert.ok(cacheKeyFor(p).startsWith("stork-aila:update:"));
});
