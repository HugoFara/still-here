/**
 * Cron-style ingestion loop (brief §3: "poll a few×/day, never realtime-spam").
 * Runs the worker immediately, then every INGEST_INTERVAL_MIN minutes (default
 * 360 = every 6h). Graceful shutdown on SIGINT/SIGTERM.
 *
 *   node src/ingestion/scheduler.ts
 *   INGEST_INTERVAL_MIN=180 npm run schedule
 *
 * In a containerized deployment you'd typically use a real cron / k8s CronJob
 * invoking `npm run ingest`; this is the single-process equivalent.
 */

import { createContext } from "../context.ts";

const MIN_MS = 60_000;

async function main(): Promise<void> {
  const intervalMin = Math.max(1, Number(process.env.INGEST_INTERVAL_MIN ?? "360"));
  const ctx = createContext();
  let running = false;
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (running) return; // never overlap runs
    running = true;
    try {
      const summaries = await ctx.worker.run(Date.now());
      const states = summaries.reduce<Record<string, number>>((acc, s) => {
        const k = s.apiPermission === "denied" ? "RETIRED" : s.state;
        acc[k] = (acc[k] ?? 0) + 1;
        return acc;
      }, {});
      console.log(
        `[${new Date().toISOString()}] ingested ${summaries.length} — ` +
          Object.entries(states).map(([k, n]) => `${k}:${n}`).join(" "),
      );
    } catch (err) {
      console.error(`[${new Date().toISOString()}] ingest tick failed:`, err);
    } finally {
      running = false;
    }
  };

  const shutdown = (sig: string): void => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    console.log(`\n${sig} received — stopping scheduler.`);
    ctx.repo.close();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  console.log(`Scheduler started — ingesting every ${intervalMin} min. Ctrl-C to stop.`);
  await tick(); // immediate first run
  const timer = setInterval(() => void tick(), intervalMin * MIN_MS);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
