// Build the static GitHub Pages export into ./docs.
//
// The follow app is normally a live server (HTTP API + a SQLite store written at
// runtime). GitHub Pages serves static files only, so this script boots the SAME
// seeded service in-process (identical to test/handoff.test.ts) and PRE-BAKES the
// deterministic fixture payloads to JSON, for BOTH A/B arms, plus the successor
// handoff variants and a frozen funnel snapshot. The client (src/web/app.js) runs
// in static mode and loads these files instead of /api.
//
// What is faithfully reproduced: the entire follow experience (roster, the Leaflet
// map, narrative, continuity states, successor bridge). What CANNOT be: the live
// A/B measurement — recording events needs a writable shared store. The experiment
// view shows a frozen snapshot, labelled as such.
//
// Re-run:  npm run static     (then commit ./docs)
import { mkdir, writeFile, rm, cp, readFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { SqliteRepository } from "../src/store/sqlite-store.ts";
import { MovebankClient } from "../src/movebank/client.ts";
import { FixtureTransport } from "../src/movebank/transport.ts";
import { NarrativeGenerator } from "../src/narrative/generator.ts";
import { MockLLMProvider } from "../src/llm/provider.ts";
import { IngestionWorker } from "../src/ingestion/worker.ts";
import { seedRuntime, seedDemoEvents } from "../src/ingestion/seed-runner.ts";
import { RosterService } from "../src/server/roster-service.ts";
import { assignArm, computeFunnel } from "../src/experiment/ab.ts";
import { DEMO_NOW } from "../src/roster/seed.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WEB = join(ROOT, "src", "web");
const OUT = join(ROOT, "docs");
const ARMS = ["narrative", "map"];

/** Boot a seeded, populated RosterService in-process (mirrors realService() in tests). */
async function bootService() {
  const dir = mkdtempSync(join(tmpdir(), "still-here-static-"));
  const repo = SqliteRepository.open(":memory:");
  await seedRuntime(repo, DEMO_NOW, dir);
  const client = new MovebankClient({ transport: new FixtureTransport(dir), defaultSurface: "v2-rest" });
  const generator = new NarrativeGenerator(new MockLLMProvider(), repo);
  const summaries = await new IngestionWorker(repo, client, generator).run(DEMO_NOW);
  // Synthetic, equal-conversion funnel traffic — identical to `npm run seed`, so the
  // experiment snapshot shows the instrument (seeded lift ~1.0), not a fabricated win.
  const liveTargets = summaries.filter((s) => s.apiPermission === "ok").map((s) => s.individualId);
  seedDemoEvents(repo, DEMO_NOW, liveTargets);
  return { repo, service: new RosterService(repo, generator) };
}

/** A session id that deterministically lands in `arm` (so getAnimal builds the arm-correct payload). */
function sessionForArm(arm) {
  for (let i = 0; i < 1000; i++) {
    const s = `static-${arm}-${i}`;
    if (assignArm(s) === arm) return s;
  }
  throw new Error(`no session id found for arm ${arm}`);
}

async function emit(rel, data) {
  const full = join(OUT, rel);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, JSON.stringify(data), "utf8");
}

async function main() {
  const { repo, service } = await bootService();
  const now = DEMO_NOW;

  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  // 1. Static copies of the web client (app.js runs in static mode via the flag below).
  for (const f of ["app.js", "styles.css"]) await cp(join(WEB, f), join(OUT, f));
  await cp(join(WEB, "vendor"), join(OUT, "vendor"), { recursive: true });

  // 2. index.html — absolute paths -> relative (Pages serves under /<repo>/), and
  //    set the static flag before app.js loads.
  let html = await readFile(join(WEB, "index.html"), "utf8");
  html = html
    .replaceAll('href="/styles.css"', 'href="styles.css"')
    .replaceAll('href="/vendor/leaflet.css"', 'href="vendor/leaflet.css"')
    .replaceAll('src="/vendor/leaflet.js"', 'src="vendor/leaflet.js"')
    .replaceAll(
      '<script src="/app.js" type="module"></script>',
      '<script>window.STATIC_EXPORT = true;</script>\n    <script src="app.js" type="module"></script>',
    );
  await writeFile(join(OUT, "index.html"), html, "utf8");

  // Disable Jekyll so folders/files are served verbatim.
  await writeFile(join(OUT, ".nojekyll"), "", "utf8");

  // 3. Roster.
  const roster = service.listRoster(now);
  await emit("api/roster.json", { roster });

  // 4. Funnel snapshot — BEFORE baking animal payloads, so it reflects only the
  //    seeded synthetic baseline (getAnimal records view/action_shown events).
  const report = computeFunnel(repo.allEvents());
  await emit("api/experiment.json", {
    ...report,
    note: "Frozen snapshot from the seeded baseline. The live A/B funnel records events server-side; a static export cannot. Shown for shape, not live measurement.",
  });

  // 5. Every animal payload in both arms; collect successor handoff edges.
  const edges = new Set(); // `${successorId}::${fromId}`
  let count = 0;
  for (const arm of ARMS) {
    const session = sessionForArm(arm);
    for (const item of roster) {
      const p = await service.getAnimal(item.id, session, now, null);
      if (!p) continue;
      await emit(`api/animal/${arm}/${item.id}.json`, p);
      count++;
      if (p.successor) edges.add(`${p.successor.id}::${item.id}`);
    }
  }

  // 6. Handoff variants: the successor payload acknowledging the thread it continues.
  for (const arm of ARMS) {
    const session = sessionForArm(arm);
    for (const edge of edges) {
      const [succId, fromId] = edge.split("::");
      const p = await service.getAnimal(succId, session, now, fromId);
      if (!p) continue;
      await emit(`api/animal/${arm}/${succId}__from__${fromId}.json`, p);
      count++;
    }
  }

  repo.close();
  console.error(
    `wrote ${OUT}: ${roster.length} animals, ${count} payloads (${ARMS.length} arms, ${edges.size} handoff edges)`,
  );
}

main().catch((e) => {
  console.error("FAILED", e);
  process.exit(1);
});
