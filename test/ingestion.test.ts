import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteRepository } from "../src/store/sqlite-store.ts";
import { MovebankClient } from "../src/movebank/client.ts";
import { FixtureTransport } from "../src/movebank/transport.ts";
import { NarrativeGenerator } from "../src/narrative/generator.ts";
import { MockLLMProvider } from "../src/llm/provider.ts";
import { IngestionWorker } from "../src/ingestion/worker.ts";
import { seedRuntime } from "../src/ingestion/seed-runner.ts";

const NOW = Date.UTC(2026, 5, 27, 12, 0, 0);

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "movebank-fix-"));
  const repo = SqliteRepository.open(":memory:");
  await seedRuntime(repo, NOW, dir);
  const client = new MovebankClient({
    transport: new FixtureTransport(dir),
    defaultSurface: "v2-rest",
  });
  const generator = new NarrativeGenerator(new MockLLMProvider(), repo);
  const worker = new IngestionWorker(repo, client, generator);
  return { repo, worker };
}

test("end-to-end ingestion produces the full spread of continuity states", async () => {
  const { repo, worker } = await setup();
  const summaries = await worker.run(NOW);
  const byId = new Map(summaries.map((s) => [s.individualId, s]));

  // States fall out of the REAL tracks' last-fix recency, not engineering.
  assert.equal(byId.get("stork-louis")!.state, "LIVE");
  assert.equal(byId.get("dove-mistral")!.state, "LIVE");
  assert.equal(byId.get("stork-rosel")!.state, "QUIET");
  assert.equal(byId.get("kite-aare")!.state, "RESOLVED_KNOWN");
  assert.equal(byId.get("stork-europa")!.state, "RESOLVED_UNKNOWN");
  assert.equal(byId.get("demo-permission-lost")!.state, "PERMISSION_LOST");
  repo.close();
});

test("permission-loss retires silently: denied, 0 fixes, no narrative", async () => {
  const { repo, worker } = await setup();
  await worker.run(NOW);
  const pip = repo.getStatus("demo-permission-lost")!;
  assert.equal(pip.state, "PERMISSION_LOST");
  assert.equal(pip.directives.retire, true);
  assert.equal(repo.getFixes("demo-permission-lost").length, 0, "no fixes ingested under denial");
  // No narrative cache entry was written for the retired animal.
  const key = `demo-permission-lost:update:${pip.observed.lastFixAt}:PERMISSION_LOST`;
  assert.equal(repo.getNarrative(key), null);
  repo.close();
});

test("live animals get fixes stored and a narrative cached", async () => {
  const { repo, worker } = await setup();
  await worker.run(NOW);
  assert.ok(repo.getFixes("stork-louis").length > 10, "fixes persisted");
  const status = repo.getStatus("stork-louis")!;
  const key = `stork-louis:update:${status.observed.lastFixAt}:LIVE`;
  assert.ok(repo.getNarrative(key), "narrative cached under the batch key");
  repo.close();
});

test("a second ingest run is fully cached and idempotent", async () => {
  const { repo, worker } = await setup();
  await worker.run(NOW);
  const second = await worker.run(NOW);
  for (const s of second) {
    assert.equal(s.newFixes, 0, "no duplicate fixes");
    assert.notEqual(s.narrative, "generated", `${s.individualId} should be cached or skipped`);
  }
  repo.close();
});
