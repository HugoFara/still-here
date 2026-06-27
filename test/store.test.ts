import { test } from "node:test";
import assert from "node:assert/strict";
import { SqliteRepository } from "../src/store/sqlite-store.ts";
import type { Fix, Individual, Study } from "../src/domain/types.ts";

function repo() {
  return SqliteRepository.open(":memory:");
}

const study: Study = {
  id: "S1",
  name: "Demo Stork Study",
  isPublic: true,
  studyType: "telemetry",
  provenance: {
    studyId: "S1",
    studyName: "Demo Stork Study",
    principalInvestigator: "Dr. Example",
    license: "CC BY-NC",
    verified: false,
  },
};

const ind: Individual = {
  id: "I1",
  studyId: "S1",
  localIdentifier: "DER A1",
  taxon: { genus: "Ciconia", species: "ciconia", commonName: "White Stork" },
  name: "Aila",
  nameIsAssigned: false,
  sex: "f",
  expectedFixesPerWeek: 7,
};

test("study + individual round-trip through sqlite", () => {
  const r = repo();
  r.upsertStudy(study);
  r.upsertIndividual(ind);
  assert.deepEqual(r.getStudy("S1"), study);
  assert.deepEqual(r.getIndividual("I1"), ind);
  assert.equal(r.listIndividuals().length, 1);
  r.close();
});

test("fix upsert is idempotent on (individual, timestamp)", () => {
  const r = repo();
  r.upsertIndividual(ind);
  const fixes: Fix[] = [
    { individualId: "I1", timestamp: 1000, lat: 48, lon: 9, sensorType: "gps" },
    { individualId: "I1", timestamp: 2000, lat: 47, lon: 8, sensorType: "gps" },
  ];
  assert.equal(r.upsertFixes(fixes), 2);
  assert.equal(r.upsertFixes(fixes), 0, "re-inserting same fixes adds nothing");
  assert.equal(
    r.upsertFixes([{ individualId: "I1", timestamp: 3000, lat: 46, lon: 7, sensorType: "gnss" }]),
    1,
  );
  assert.equal(r.getFixes("I1").length, 3);
  assert.equal(r.getFixes("I1", 2500).length, 1, "since filter works");
  r.close();
});

test("events accumulate for the funnel", () => {
  const r = repo();
  r.recordEvent({ sessionId: "s", individualId: "I1", arm: "narrative", type: "follow", ts: 1 });
  r.recordEvent({
    sessionId: "s",
    individualId: "I1",
    arm: "narrative",
    type: "action_taken",
    ts: 2,
    meta: { action: "invite" },
  });
  const all = r.allEvents();
  assert.equal(all.length, 2);
  assert.equal(all[1]!.meta?.action, "invite");
  r.close();
});

test("resetAll wipes every table so re-seeding is deterministic", () => {
  const r = repo();
  r.upsertStudy(study);
  r.upsertIndividual(ind);
  r.upsertFixes([{ individualId: "I1", timestamp: 1, lat: 1, lon: 1, sensorType: "gps" }]);
  r.recordEvent({ sessionId: "s", individualId: "I1", arm: "map", type: "follow", ts: 1 });
  r.resetAll();
  assert.equal(r.getStudy("S1"), null);
  assert.equal(r.getIndividual("I1"), null);
  assert.equal(r.getFixes("I1").length, 0);
  assert.equal(r.allEvents().length, 0);
  r.close();
});

test("license acceptance is recorded and queryable", () => {
  const r = repo();
  assert.equal(r.hasAcceptedLicense("S1"), false);
  r.recordLicenseAcceptance("S1", "abc123");
  r.recordLicenseAcceptance("S1", "abc123"); // idempotent
  assert.equal(r.hasAcceptedLicense("S1"), true);
  r.close();
});
