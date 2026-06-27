import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assignArm,
  chooseAction,
  computeFunnel,
} from "../src/experiment/ab.ts";
import { pickSuccessor, type SuccessorCandidate } from "../src/roster/successor.ts";
import type {
  ContinuityStatus,
  Individual,
  Arm,
} from "../src/domain/types.ts";
import type { GroundingPacket } from "../src/narrative/grounding.ts";
import type { EventRecord } from "../src/store/repository.ts";

const ind = (over: Partial<Individual>): Individual => ({
  id: "i",
  studyId: "s",
  localIdentifier: "L",
  taxon: { genus: "Ciconia", species: "ciconia", commonName: "White Stork" },
  name: "Aila",
  nameIsAssigned: false,
  sex: "f",
  expectedFixesPerWeek: 7,
  ...over,
});

const status = (state: ContinuityStatus["state"], showAction: boolean): ContinuityStatus =>
  ({
    individualId: "i",
    state,
    enteredAt: 0,
    rationale: "",
    observed: { lastFixAt: 0, gapHours: 0, recentFixCount: 0, apiPermission: "ok", ownerResolution: null },
    directives: {
      framing: "live",
      tone: "present",
      showAction,
      offerSuccessor: showAction,
      requestRecap: false,
      retire: false,
      alarm: false,
    },
  }) as ContinuityStatus;

const packet = (over: Partial<GroundingPacket>): GroundingPacket =>
  ({ totalTrackKm: 1500, landmarkCrossed: null, ...over }) as GroundingPacket;

test("A/B assignment is deterministic and stickily per-session", () => {
  assert.equal(assignArm("session-abc"), assignArm("session-abc"), "stable per session");
  // A different salt is an independent experiment: it reassigns at least some
  // sessions (otherwise the salt would be inert).
  let differs = 0;
  for (let i = 0; i < 200; i++) {
    if (assignArm(`s${i}`, "v1") !== assignArm(`s${i}`, "v2")) differs++;
  }
  assert.ok(differs > 0, "salt influences assignment");
});

test("A/B split is roughly balanced across many sessions", () => {
  let narrative = 0;
  for (let i = 0; i < 5000; i++) if (assignArm(`s${i}`) === "narrative") narrative++;
  const frac = narrative / 5000;
  assert.ok(frac > 0.45 && frac < 0.55, `split ${frac} should be ~0.5`);
});

test("milestone peak (LIVE + landmark) surfaces exactly one recruit action", () => {
  const a = chooseAction(ind({}), status("LIVE", false), packet({ landmarkCrossed: "the Strait of Gibraltar" }));
  assert.ok(a);
  assert.equal(a!.kind, "recruit-follower");
  assert.equal(a!.reason, "milestone");
  assert.match(a!.shareText, /Strait of Gibraltar/);
});

test("no peak (LIVE, no landmark) surfaces no action — we don't nag mid-journey", () => {
  assert.equal(chooseAction(ind({}), status("LIVE", false), packet({})), null);
});

test("resolution hands off to a successor when one exists", () => {
  const successor = ind({ id: "j", name: "Brennus", taxon: { genus: "Pandion", species: "haliaetus", commonName: "Osprey" } });
  const a = chooseAction(ind({}), status("RESOLVED_KNOWN", true), packet({}), { successor });
  assert.ok(a);
  assert.equal(a!.reason, "resolution");
  assert.equal(a!.targetIndividualId, "j");
  assert.match(a!.shareText, /Brennus/);
});

test("resolution with no successor still offers exactly one (share) action", () => {
  const a = chooseAction(ind({}), status("RESOLVED_UNKNOWN", true), packet({ totalTrackKm: 4200 }), { successor: null });
  assert.ok(a);
  assert.match(a!.shareText, /4200 km|4200/);
});

test("pickSuccessor prefers same species, then theme, only live-eligible", () => {
  const resolved = ind({ id: "dead", taxon: { genus: "Pandion", species: "haliaetus", commonName: "Osprey" } });
  const candidates: SuccessorCandidate[] = [
    { individual: ind({ id: "stork", taxon: { genus: "Ciconia", species: "ciconia", commonName: "White Stork" } }), theme: "bird", liveEligible: true, score: 0.9 },
    { individual: ind({ id: "osprey", taxon: { genus: "Pandion", species: "haliaetus", commonName: "Osprey" } }), theme: "bird", liveEligible: true, score: 0.5 },
    { individual: ind({ id: "dead-osprey", taxon: { genus: "Pandion", species: "haliaetus", commonName: "Osprey" } }), theme: "bird", liveEligible: false, score: 1.0 },
  ];
  const s = pickSuccessor(resolved, "bird", candidates);
  assert.equal(s!.id, "osprey", "same-species live bird wins despite lower score");
});

test("funnel counts unique sessions per stage and computes the lift", () => {
  const ev = (sessionId: string, arm: Arm, type: EventRecord["type"]): EventRecord => ({
    sessionId,
    individualId: "i",
    arm,
    type,
    ts: 1,
  });
  const events: EventRecord[] = [
    // narrative arm: 2 followers, 1 acts
    ev("n1", "narrative", "follow"), ev("n1", "narrative", "view"),
    ev("n1", "narrative", "action_shown"), ev("n1", "narrative", "action_taken"),
    ev("n1", "narrative", "action_taken"), // duplicate must not double-count
    ev("n2", "narrative", "follow"), ev("n2", "narrative", "action_shown"),
    // map arm: 2 followers, 0 act
    ev("m1", "map", "follow"), ev("m1", "map", "action_shown"),
    ev("m2", "map", "follow"),
  ];
  const report = computeFunnel(events);
  const narrative = report.arms.find((a) => a.arm === "narrative")!;
  const map = report.arms.find((a) => a.arm === "map")!;

  assert.equal(narrative.follow, 2);
  assert.equal(narrative.action_taken, 1, "deduped per session");
  assert.equal(narrative.followToAction, 0.5);
  assert.equal(map.followToAction, 0);
  assert.equal(report.narrativeLiftVsMap, null, "lift is null when control conversion is 0");
});

test("funnel lift is a finite ratio when both arms convert", () => {
  const ev = (sessionId: string, arm: Arm, type: EventRecord["type"]): EventRecord => ({ sessionId, individualId: "i", arm, type, ts: 1 });
  const events: EventRecord[] = [
    ev("n1", "narrative", "follow"), ev("n1", "narrative", "action_taken"),
    ev("n2", "narrative", "follow"),
    ev("m1", "map", "follow"), ev("m1", "map", "action_taken"),
    ev("m2", "map", "follow"), ev("m3", "map", "follow"), ev("m4", "map", "follow"),
  ];
  const report = computeFunnel(events);
  // narrative 1/2 = 0.5 ; map 1/4 = 0.25 ; lift = 2.0
  assert.equal(report.narrativeLiftVsMap, 2);
});
