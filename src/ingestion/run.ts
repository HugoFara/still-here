/**
 * Ingestion CLI entrypoint.
 *   node src/ingestion/run.ts            # ingest the existing roster once
 *   node src/ingestion/run.ts --seed     # (re)seed the demo roster, then ingest
 *
 * In production this is what a scheduler runs a few times a day.
 */

import { createContext, RUNTIME_FIXTURE_DIR } from "../context.ts";
import { seedDemoEvents, seedRuntime } from "./seed-runner.ts";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const doSeed = args.includes("--seed");
  const ctx = createContext();
  const now = Date.now();

  if (doSeed) {
    const { animals, studies } = await seedRuntime(ctx.repo, now, RUNTIME_FIXTURE_DIR);
    console.log(`Seeded ${studies} studies and ${animals} individuals → ${RUNTIME_FIXTURE_DIR}`);
  }

  const summaries = await ctx.worker.run(now);

  if (doSeed) {
    // Synthetic, equal-conversion funnel traffic so the dashboard isn't empty.
    const liveTargets = summaries
      .filter((s) => s.apiPermission === "ok")
      .map((s) => s.individualId);
    const n = seedDemoEvents(ctx.repo, now, liveTargets);
    console.log(`Seeded ${n} synthetic funnel events (equal conversion across arms).`);
  }
  if (summaries.length === 0) {
    console.log("No individuals in the roster. Run with --seed first.");
  } else {
    console.log("\nIngestion summary:");
    for (const s of summaries) {
      const tag = s.apiPermission === "denied" ? "RETIRED" : s.state;
      const note = s.note ? `  (${s.note})` : "";
      console.log(
        `  ${s.individualId.padEnd(16)} ${tag.padEnd(18)} +${s.newFixes} fixes` +
          `  [narrative ${s.narrative}]${note}`,
      );
    }
  }

  ctx.repo.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
