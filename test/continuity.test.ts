import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeStatus,
  isResolved,
  DEFAULT_CONTINUITY_CONFIG,
  type ContinuityInput,
} from "../src/domain/continuity.ts";
import type { Fix } from "../src/domain/types.ts";

const NOW = Date.UTC(2026, 5, 27, 12, 0, 0); // 2026-06-27T12:00Z, fixed clock
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function fix(hoursAgo: number, lat = 48.0, lon = 9.0): Fix {
  return {
    individualId: "ind-1",
    timestamp: NOW - hoursAgo * HOUR,
    lat,
    lon,
    sensorType: "gps",
  };
}

function input(over: Partial<ContinuityInput>): ContinuityInput {
  return {
    individualId: "ind-1",
    now: NOW,
    expectedFixesPerWeek: 7, // ~1/day → quiet after 3 days at default x3
    fixes: [],
    ...over,
  };
}

test("LIVE: a fresh daily fix is live and present-tense", () => {
  const s = computeStatus(input({ fixes: [fix(6), fix(30), fix(54)] }));
  assert.equal(s.state, "LIVE");
  assert.equal(s.directives.framing, "live");
  assert.equal(s.directives.tone, "present");
  assert.equal(s.directives.showAction, false);
  assert.equal(s.observed.recentFixCount, 3);
  assert.equal(s.enteredAt, NOW - 6 * HOUR); // last fix
});

test("QUIET: past cadence but under lost threshold → resting, hopeful, no alarm", () => {
  // expected interval = 24h, quiet after 72h. Gap of 5 days trips QUIET.
  const s = computeStatus(input({ fixes: [fix(5 * 24)] }));
  assert.equal(s.state, "QUIET");
  assert.equal(s.directives.framing, "resting");
  assert.equal(s.directives.tone, "soft-hopeful");
  assert.equal(s.directives.requestRecap, true, "keep engagement via recap");
  assert.equal(s.directives.alarm, false);
  assert.equal(s.enteredAt, NOW - 5 * DAY, "entered when silence began");
});

test("boundary: exactly at the quiet threshold is still LIVE", () => {
  // quietAfter = 72h exactly; gap == 72h should be inclusive-LIVE.
  const s = computeStatus(input({ fixes: [fix(72)] }));
  assert.equal(s.state, "LIVE");
  const justOver = computeStatus(input({ fixes: [fix(72.5)] }));
  assert.equal(justOver.state, "QUIET");
});

test("RESOLVED_UNKNOWN: silence beyond lost threshold → honest closure + handoff", () => {
  const s = computeStatus(input({ fixes: [fix(40 * 24)] })); // 40 days
  assert.equal(s.state, "RESOLVED_UNKNOWN");
  assert.equal(s.directives.framing, "ending-unknown");
  assert.equal(s.directives.tone, "honest-closure");
  assert.equal(s.directives.showAction, true, "offer the one action");
  assert.equal(s.directives.offerSuccessor, true, "graceful handoff");
});

test("RESOLVED_KNOWN: owner death overrides an otherwise-live track", () => {
  const s = computeStatus(
    input({
      fixes: [fix(2)], // would be LIVE on gap alone
      ownerResolution: { kind: "death", at: NOW - 12 * HOUR, note: "found deceased" },
    }),
  );
  assert.equal(s.state, "RESOLVED_KNOWN");
  assert.equal(s.directives.showAction, true);
  assert.equal(s.directives.offerSuccessor, true);
  assert.equal(s.enteredAt, NOW - 12 * HOUR, "entered at the resolution time");
  assert.match(s.rationale, /death/);
});

test("owner resolution in the future is not yet effective", () => {
  const s = computeStatus(
    input({
      fixes: [fix(2)],
      ownerResolution: { kind: "study-ended", at: NOW + DAY },
    }),
  );
  assert.equal(s.state, "LIVE", "future resolution does not apply yet");
});

test("PERMISSION_LOST: API denial wins over everything and retires silently", () => {
  const s = computeStatus(
    input({
      fixes: [fix(2)],
      apiPermission: "denied",
      ownerResolution: { kind: "death", at: NOW - DAY }, // even with a resolution
    }),
  );
  assert.equal(s.state, "PERMISSION_LOST");
  assert.equal(s.directives.retire, true);
  assert.equal(s.directives.framing, "retire-silently");
  assert.equal(s.directives.showAction, false, "never present as disappearance");
});

test("permission-denied is distinct from tag-went-quiet", () => {
  const quiet = computeStatus(input({ fixes: [fix(6 * 24)] }));
  const denied = computeStatus(input({ fixes: [fix(6 * 24)], apiPermission: "denied" }));
  assert.notEqual(quiet.state, denied.state);
  assert.equal(quiet.directives.retire, false);
  assert.equal(denied.directives.retire, true);
});

test("no fixes at all is never reported as LIVE", () => {
  const s = computeStatus(input({ fixes: [] }));
  assert.equal(s.state, "RESOLVED_UNKNOWN");
  assert.equal(s.observed.lastFixAt, null);
  assert.equal(s.observed.gapHours, null);
});

test("cadence scales the quiet threshold: a weekly bird stays live for longer", () => {
  // 1 fix/week → interval 168h → quiet after 504h (21 days).
  const weekly = input({ expectedFixesPerWeek: 1, fixes: [fix(10 * 24)] });
  assert.equal(computeStatus(weekly).state, "LIVE", "10 days fine for a weekly tag");

  // A daily bird with the same 10-day gap is QUIET.
  const daily = input({ expectedFixesPerWeek: 7, fixes: [fix(10 * 24)] });
  assert.equal(computeStatus(daily).state, "QUIET");
});

test("the alarm invariant holds across every state", () => {
  const cases: ContinuityInput[] = [
    input({ fixes: [fix(2)] }),
    input({ fixes: [fix(6 * 24)] }),
    input({ fixes: [fix(40 * 24)] }),
    input({ fixes: [fix(2)], ownerResolution: { kind: "death", at: NOW - DAY } }),
    input({ fixes: [fix(2)], apiPermission: "denied" }),
  ];
  for (const c of cases) assert.equal(computeStatus(c).directives.alarm, false);
});

test("isResolved flags only terminal story states", () => {
  assert.equal(isResolved("RESOLVED_KNOWN"), true);
  assert.equal(isResolved("RESOLVED_UNKNOWN"), true);
  assert.equal(isResolved("LIVE"), false);
  assert.equal(isResolved("QUIET"), false);
  assert.equal(isResolved("PERMISSION_LOST"), false);
});

test("recentFixCount only counts fixes inside the window and not the future", () => {
  const s = computeStatus(
    input({
      expectedFixesPerWeek: 1,
      fixes: [fix(1), fix(5 * 24), fix(20 * 24)], // 20d is outside 14d window
    }),
    DEFAULT_CONTINUITY_CONFIG,
  );
  assert.equal(s.observed.recentFixCount, 2);
});
