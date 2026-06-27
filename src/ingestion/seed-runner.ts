/**
 * Seeds the store + writes runtime fixtures so the whole pipeline
 * (client → worker → continuity → narrative) runs offline against the curated
 * roster. Anchored to `now` so the continuity states are always fresh.
 *
 * The permission-lost animal gets a permission-denied fixture (not empty data),
 * which makes the client throw and exercises the retire-silently path for real.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildSeed } from "../roster/seed.ts";
import { assignArm } from "../experiment/ab.ts";
import type { Repository } from "../store/repository.ts";
import type { Fix } from "../domain/types.ts";

function toWire(f: Fix): Record<string, unknown> {
  return {
    timestamp: f.timestamp,
    location_lat: f.lat,
    location_long: f.lon,
    sensor_type: f.sensorType,
  };
}

export async function seedRuntime(
  repo: Repository,
  now: number,
  fixtureDir: string,
): Promise<{ animals: number; studies: number }> {
  const seed = buildSeed(now);

  // Clean slate so re-seeding is deterministic: synthetic tracks re-anchor their
  // timestamps each run, so without this, fixes + events would accumulate.
  repo.resetAll();

  for (const s of seed.studies) repo.upsertStudy(s);

  const locDir = join(fixtureDir, "get-locations");
  await mkdir(locDir, { recursive: true });

  for (const a of seed.animals) {
    repo.upsertIndividual(a.individual);
    repo.setResolution(a.individual.id, a.ownerResolution ?? null);

    const path = join(locDir, `${a.individual.id}.json`);
    if (a.permissionLost) {
      await writeFile(
        path,
        JSON.stringify(
          {
            permissionDenied: true,
            message:
              "No data are available. The data owner has revoked access to this individual.",
          },
          null,
          2,
        ),
      );
    } else {
      await writeFile(
        path,
        JSON.stringify({ locations: a.fixes.map(toWire) }, null, 2),
      );
    }
  }

  return { animals: seed.animals.length, studies: seed.studies.length };
}

function h32(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Synthetic funnel traffic so the experiment dashboard is non-empty out of the
 * box. HONEST by construction: conversion is the SAME for both arms (no baked-in
 * winner), so the seeded lift sits near 1.0 — the demo shows the instrument, not
 * a fabricated result. Real session events accumulate on top of this.
 */
export function seedDemoEvents(
  repo: Repository,
  now: number,
  followTargets: string[],
  // Large enough that the equal-conversion design lands the seeded lift near
  // 1.0 (small samples make noise look like a result — exactly what we warn
  // against). Real traffic is what should ever move this.
  sessions = 1200,
): number {
  if (followTargets.length === 0) return 0;
  let written = 0;
  const record = (sessionId: string, individualId: string, type: "follow" | "view" | "engage" | "action_shown" | "action_taken") => {
    repo.recordEvent({ sessionId, individualId, arm: assignArm(sessionId), type, ts: now });
    written++;
  };
  // Per-arm counters so action conversion is EXACTLY ~20% of shown in BOTH arms
  // — no spurious lift from sampling noise. The instrument, not a fabricated win.
  const shownBy: Record<string, number> = { narrative: 0, map: 0 };
  const takenBy: Record<string, number> = { narrative: 0, map: 0 };
  for (let i = 0; i < sessions; i++) {
    const sid = `seed-${i}`;
    const target = followTargets[i % followTargets.length]!;
    const arm = assignArm(sid);
    const r = h32(sid) % 100;
    record(sid, target, "follow");
    if (r < 90) record(sid, target, "view");
    if (r < 60) record(sid, target, "engage");
    if (r < 55) {
      record(sid, target, "action_shown");
      shownBy[arm]!++;
      if (takenBy[arm]! < 0.2 * shownBy[arm]!) {
        record(sid, target, "action_taken");
        takenBy[arm]!++;
      }
    }
  }
  return written;
}
