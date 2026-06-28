import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildHandoffBridge,
  describeConnection,
} from "../src/roster/successor.ts";
import { SqliteRepository } from "../src/store/sqlite-store.ts";
import { MovebankClient } from "../src/movebank/client.ts";
import { FixtureTransport } from "../src/movebank/transport.ts";
import { NarrativeGenerator } from "../src/narrative/generator.ts";
import { MockLLMProvider } from "../src/llm/provider.ts";
import { IngestionWorker } from "../src/ingestion/worker.ts";
import { seedRuntime } from "../src/ingestion/seed-runner.ts";
import { RosterService } from "../src/server/roster-service.ts";
import { DEMO_NOW } from "../src/roster/seed.ts";
import type { Fix, Individual } from "../src/domain/types.ts";

const DAY = 86_400_000;

function bird(id: string, studyId: string, species: string, common: string): Individual {
  return {
    id,
    studyId,
    localIdentifier: id.toUpperCase(),
    taxon: { genus: common.split(" ")[0] ?? "Genus", species, commonName: common },
    name: id,
    nameIsAssigned: false,
    sex: "unknown",
    expectedFixesPerWeek: 7,
  };
}

/** A short track sitting on a single gazetteer waypoint. */
function near(id: string, lat: number, lon: number, startTs: number): Fix[] {
  return Array.from({ length: 4 }, (_, i): Fix => ({
    individualId: id,
    timestamp: startTs + i * DAY,
    lat,
    lon,
    sensorType: "gps",
  }));
}

// Gazetteer waypoints (src/domain/places.ts).
const LAKE_CONSTANCE = [47.66, 9.18] as const;
const UPPER_RHINE = [49.0, 8.4] as const;
const RHONE = [44.5, 4.8] as const;
const BERN = [46.95, 7.45] as const;

test("describeConnection grounds same-species, same-study, and a shared place", () => {
  const resolved = bird("rolf", "A", "ciconia", "White Stork");
  const successor = bird("nia", "A", "ciconia", "White Stork");
  // Resolved passed Lake Constance then the Upper Rhine plain; successor is on
  // the Upper Rhine plain now — a place the resolved animal also crossed.
  const resolvedFixes = [
    ...near("rolf", LAKE_CONSTANCE[0], LAKE_CONSTANCE[1], 0),
    ...near("rolf", UPPER_RHINE[0], UPPER_RHINE[1], 10 * DAY),
  ];
  const successorFixes = near("nia", UPPER_RHINE[0], UPPER_RHINE[1], 100 * DAY);

  const conn = describeConnection(resolved, resolvedFixes, successor, successorFixes, "LIVE");
  assert.equal(conn.sameSpecies, true);
  assert.equal(conn.sameStudy, true);
  assert.equal(conn.sharedPlace, "the Upper Rhine plain", "shared geography is detected");
  assert.match(conn.successorPlace ?? "", /Upper Rhine plain/);
  assert.equal(conn.successorState, "LIVE");
});

test("buildHandoffBridge is grounded: names the successor + species + the real link", () => {
  const successor = bird("nia", "A", "ciconia", "White Stork");
  const conn = {
    sameSpecies: true,
    sameStudy: true,
    sharedPlace: "the Upper Rhine plain",
    successorPlace: "near the Upper Rhine plain",
    successorState: "LIVE" as const,
  };
  const bridge = buildHandoffBridge("Rolf", successor, conn);
  assert.match(bridge, /nia/i, "names the successor");
  assert.match(bridge, /another White Stork/, "same species framed as 'another'");
  assert.match(bridge, /same study/i, "surfaces the grounded study link");
  assert.match(bridge, /Rolf/, "ties back to the resolved animal");
  // Never invents a place not in the connection.
  assert.doesNotMatch(bridge, /Doñana|Sahel|Gibraltar/);
});

test("buildHandoffBridge stays honest with no shared link (cross-species, different study)", () => {
  const successor = bird("mistral", "D", "turtur", "European Turtle Dove");
  const conn = describeConnection(
    bird("aare", "K", "milvus", "Red Kite"),
    near("aare", BERN[0], BERN[1], 0),
    successor,
    near("mistral", RHONE[0], RHONE[1], 100 * DAY),
    "LIVE",
  );
  assert.equal(conn.sameSpecies, false);
  assert.equal(conn.sameStudy, false);
  assert.equal(conn.sharedPlace, null, "no fabricated shared geography");

  const bridge = buildHandoffBridge("Aare", successor, conn);
  assert.match(bridge, /a European Turtle Dove/, "no 'another' for a different species");
  assert.match(bridge, /Rh[ôo]ne/, "grounds where the successor actually is");
  assert.doesNotMatch(bridge, /same study|crossed too/i, "claims no link the data lacks");
});

// --- end to end on the REAL roster -----------------------------------------

async function realService() {
  const dir = mkdtempSync(join(tmpdir(), "movebank-handoff-"));
  const repo = SqliteRepository.open(":memory:");
  await seedRuntime(repo, DEMO_NOW, dir);
  const client = new MovebankClient({
    transport: new FixtureTransport(dir),
    defaultSurface: "v2-rest",
  });
  const generator = new NarrativeGenerator(new MockLLMProvider(), repo);
  const worker = new IngestionWorker(repo, client, generator);
  await worker.run(DEMO_NOW);
  return { repo, service: new RosterService(repo, generator) };
}

test("a resolved real stork hands off to a grounded live successor, and the thread is carried", async () => {
  const { repo, service } = await realService();

  const europa = await service.getAnimal("stork-europa", "sess-handoff", DEMO_NOW);
  assert.ok(europa, "Europa is viewable (resolutions are not retired)");
  assert.equal(europa!.status.state, "RESOLVED_UNKNOWN");

  const succ = europa!.successor;
  assert.ok(succ, "a successor is offered at the resolution");
  // The live successor is another White Stork → a genuine, grounded link.
  assert.equal(succ!.connection.sameSpecies, true, "successor shares the species");
  assert.match(succ!.bridge, /White Stork/);
  assert.match(succ!.bridge, new RegExp(succ!.name), "the bridge names the successor");

  // Following the handoff carries the thread: the successor view knows where we came from.
  const next = await service.getAnimal(succ!.id, "sess-handoff", DEMO_NOW, "stork-europa");
  assert.ok(next);
  assert.ok(next!.continuedFrom, "the successor view acknowledges the handoff");
  assert.equal(next!.continuedFrom!.name, "Europa");
  assert.equal(next!.continuedFrom!.species, "White Stork");

  repo.close();
});
