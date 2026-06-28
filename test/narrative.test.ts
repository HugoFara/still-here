import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGroundingPacket, cacheKeyFor } from "../src/narrative/grounding.ts";
import { MockLLMProvider } from "../src/llm/provider.ts";
import { NarrativeGenerator } from "../src/narrative/generator.ts";
import { computeStatus } from "../src/domain/continuity.ts";
import { buildTrack } from "../src/roster/track-builder.ts";
import { SqliteRepository } from "../src/store/sqlite-store.ts";
import type { Fix, Individual, OwnerResolution } from "../src/domain/types.ts";

// Self-contained SYNTHETIC fixtures — these tests exercise the narrative/grounding
// LOGIC and need a controlled track (known landmarks, places, gaps). They are
// deliberately decoupled from the runtime roster (which is real Movebank data and
// must not anchor unit assertions about specific places).
const NOW = Date.UTC(2026, 5, 27, 12, 0, 0);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// flyway waypoints matching the gazetteer (src/domain/places.ts)
const W = {
  constance: { lat: 47.66, lon: 9.18 },
  camargue: { lat: 43.53, lon: 4.42 },
  ebro: { lat: 40.72, lon: 0.73 },
  donana: { lat: 37.0, lon: -6.45 },
  gibraltar: { lat: 35.95, lon: -5.6 },
  rutland: { lat: 52.65, lon: -0.63 },
  biscay: { lat: 45.6, lon: -1.1 },
  bosphorus: { lat: 41.1, lon: 29.05 },
  nile: { lat: 27.0, lon: 31.2 },
  sahara: { lat: 25.0, lon: -10.0 },
};

interface Animal {
  individual: Individual;
  fixes: Fix[];
  ownerResolution?: OwnerResolution;
}

function stork(id: string, name: string, sex: "m" | "f"): Omit<Individual, "id"> & { id: string } {
  return {
    id,
    studyId: "demo",
    localIdentifier: id.toUpperCase(),
    taxon: { genus: "Ciconia", species: "ciconia", commonName: "White Stork" },
    name,
    nameIsAssigned: false,
    sex,
    expectedFixesPerWeek: 7,
  };
}

const ANIMALS: Record<string, Animal> = {
  // LIVE — crosses the Strait of Gibraltar, starts at Lake Constance.
  "stork-aila": {
    individual: stork("stork-aila", "Aila", "f"),
    fixes: buildTrack({
      individualId: "stork-aila",
      waypoints: [W.constance, W.camargue, W.ebro, W.donana, W.gibraltar],
      endAt: NOW - 6 * HOUR,
      cadenceHours: 24,
      count: 55,
    }),
  },
  // QUIET — paused 6 days ago.
  "stork-niko": {
    individual: stork("stork-niko", "Niko", "m"),
    fixes: buildTrack({
      individualId: "stork-niko",
      waypoints: [W.constance, W.camargue, W.donana],
      endAt: NOW - 6 * DAY,
      cadenceHours: 24,
      count: 35,
    }),
  },
  // RESOLVED_KNOWN — owner says tag recovered / deployment ended.
  "osprey-skylla": {
    individual: {
      id: "osprey-skylla",
      studyId: "demo",
      localIdentifier: "OSP-1991",
      taxon: { genus: "Pandion", species: "haliaetus", commonName: "Osprey" },
      name: "Skylla",
      nameIsAssigned: false,
      sex: "f",
      expectedFixesPerWeek: 7,
    },
    ownerResolution: {
      kind: "tag-removed",
      at: NOW - 10 * DAY,
      note: "Tag recovered in good condition; the study deployment for this bird ended.",
    },
    fixes: buildTrack({
      individualId: "osprey-skylla",
      waypoints: [W.rutland, W.biscay, W.donana],
      endAt: NOW - 10 * DAY,
      cadenceHours: 24,
      count: 30,
    }),
  },
  // RESOLVED_UNKNOWN — signal lost 40 days ago over the Sahara.
  "eagle-viljo": {
    individual: {
      id: "eagle-viljo",
      studyId: "demo",
      localIdentifier: "LSE-Viljo",
      taxon: { genus: "Clanga", species: "pomarina", commonName: "Lesser Spotted Eagle" },
      name: "Viljo",
      nameIsAssigned: false,
      sex: "m",
      expectedFixesPerWeek: 3.5,
    },
    fixes: buildTrack({
      individualId: "eagle-viljo",
      waypoints: [W.bosphorus, W.nile, W.sahara],
      endAt: NOW - 40 * DAY,
      cadenceHours: 48,
      count: 25,
    }),
  },
};

function statusFor(id: string) {
  const a = ANIMALS[id]!;
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
  const a = ANIMALS["stork-aila"]!;
  const p = buildGroundingPacket(a.individual, a.fixes, statusFor("stork-aila"), ctx);
  assert.equal(p.state, "LIVE");
  assert.equal(p.kind, "update");
  assert.ok(p.totalTrackKm > 1000, "stork has migrated > 1000 km");
  assert.equal(p.landmarkCrossed, "the Strait of Gibraltar", "detects the landmark crossing");
  assert.ok(p.latestPlace);
  assert.equal(p.startPlace?.place.name, "Lake Constance");
});

test("mock update is concrete, names the animal, and never leaks coordinates", async () => {
  const a = ANIMALS["stork-aila"]!;
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
  const a = ANIMALS["stork-niko"]!;
  const status = statusFor("stork-niko");
  assert.equal(status.state, "QUIET");
  const p = buildGroundingPacket(a.individual, a.fixes, status, ctx);
  const text = await mock.generate(p);
  assert.match(text, /quiet|resting/i);
  assert.doesNotMatch(text, /lost|dead|died|alarm|error|missing/i);
});

test("RESOLVED_KNOWN is a designed ending: past tense, recap, owner note, thanks", async () => {
  const a = ANIMALS["osprey-skylla"]!;
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
  const a = ANIMALS["eagle-viljo"]!;
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
  const a = ANIMALS["stork-aila"]!;
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
  const a = ANIMALS["stork-aila"]!;
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
