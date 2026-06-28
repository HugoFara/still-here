// Capture real, decimated Movebank tracks for the verified roster and (re)write
// src/roster/real-tracks.generated.ts. Network required; not part of the build.
//
//   node scripts/capture-real-roster.mjs
//
// Reads the fully-public JSON service (suspend_license_terms=true studies),
// keeping timestamps/coords VERBATIM and downsampling each track to <=MAXP fixes
// (first + last preserved exactly — the last fix drives continuity state).
// See README → "Going live": confirm each study's PI/license before publishing.

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const BASE = "https://www.movebank.org/movebank/service/public/json";
const NOW = Date.now();
const D = 86_400_000;
const MAXP = 130;
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "roster", "real-tracks.generated.ts");

// (internal key, study id, local-identifier matcher, match mode, role, window start)
const TARGETS = [
  { key: "stork-louis",   study: "21231406",   match: "Louis",               how: "prefix", role: "LIVE",             start: NOW - 220 * D },
  { key: "stork-noe",     study: "1562253659", match: "Noé",                 how: "prefix", role: "LIVE",             start: NOW - 220 * D },
  { key: "dove-menorca1", study: "3413045568", match: "SP_Menorca 2025_1",   how: "exact",  role: "LIVE",             start: NOW - 220 * D },
  { key: "buzzard-honey", study: "186178781",  match: "Honey Buzzard 12212", how: "prefix", role: "LIVE",             start: NOW - 320 * D },
  { key: "stork-rosel",   study: "3883692006", match: "Rosel",               how: "prefix", role: "QUIET",            start: NOW - 220 * D },
  { key: "stork-europa",  study: "21231406",   match: "Europa",              how: "prefix", role: "RESOLVED_UNKNOWN", start: NOW - 320 * D },
  { key: "kite-337",      study: "672882373",  match: "337",                 how: "exact",  role: "RESOLVED_KNOWN",   start: Date.parse("2017-01-01T00:00:00Z") },
];

async function getJson(url) {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json };
}

function matchInd(inds, match, how) {
  return inds.find((i) => {
    const id = (i.individual_local_identifier ?? "").trim();
    return how === "exact" ? id === match : id.startsWith(match);
  });
}

function decimate(locs, maxp) {
  if (locs.length <= maxp) return locs;
  const step = (locs.length - 1) / (maxp - 1);
  const out = [];
  for (let i = 0; i < maxp; i++) out.push(locs[Math.round(i * step)]);
  const seen = new Set();
  const uniq = [];
  for (const l of out) { if (!seen.has(l.ts)) { seen.add(l.ts); uniq.push(l); } }
  if (uniq[uniq.length - 1].ts !== locs[locs.length - 1].ts) uniq.push(locs[locs.length - 1]);
  return uniq;
}

async function capture(t) {
  const url = `${BASE}?study_id=${t.study}&sensor_type=gps&timestamp_start=${t.start}&timestamp_end=${NOW}`;
  const { json } = await getJson(url);
  const inds = Array.isArray(json?.individuals) ? json.individuals : [];
  const ind = matchInd(inds, t.match, t.how);
  if (!ind) throw new Error(`no match for "${t.match}" in study ${t.study}`);
  const locs = (ind.locations ?? [])
    .map((l) => ({ ts: +l.timestamp, lat: +l.location_lat, lon: +l.location_long }))
    .filter((l) => Number.isFinite(l.ts) && Number.isFinite(l.lat) && Number.isFinite(l.lon))
    .sort((a, b) => a.ts - b.ts);
  const dec = decimate(locs, MAXP);
  return {
    key: t.key,
    role: t.role,
    studyId: t.study,
    localIdentifier: (ind.individual_local_identifier ?? "").trim(),
    taxon: (ind.individual_taxon_canonical_name ?? "").trim(),
    fullCount: locs.length,
    lastTs: locs[locs.length - 1].ts,
    fixes: dec.map((l) => [l.ts, +l.lat.toFixed(5), +l.lon.toFixed(5)]),
  };
}

function tsModule(captures, capturedAt) {
  const head = `/**
 * GENERATED — do not edit by hand. Real Movebank tracks for the verified roster,
 * captured ${new Date(capturedAt).toISOString().slice(0, 10)} from the fully-public JSON service
 * (suspend_license_terms=true studies). Tracks are DOWNSAMPLED for the offline
 * snapshot (<=${MAXP} fixes each; first+last preserved exactly). Timestamps/coords are
 * REAL and unmodified. Live ingestion (MOVEBANK_MODE=live) reads full resolution.
 *
 * Regenerate: node scripts/capture-real-roster.mjs (network required).
 */

export interface RealTrack {
  studyId: string;
  localIdentifier: string;
  taxonCanonical: string;
  /** Total real fixes in the captured window (before downsampling). */
  sourceFixCount: number;
  /** [timestampMs, lat, lon] — chronological, real, downsampled. */
  fixes: ReadonlyArray<readonly [number, number, number]>;
}

/** Instant the live cohort was current — anchors the offline demo clock. */
export const CAPTURED_AT = ${capturedAt};

export const REAL_TRACKS: Record<string, RealTrack> = {
`;
  const body = captures.map((c) => {
    const fixLines = c.fixes.map((f) => `      [${f[0]}, ${f[1]}, ${f[2]}],`).join("\n");
    return `  ${JSON.stringify(c.key)}: {
    studyId: ${JSON.stringify(c.studyId)},
    localIdentifier: ${JSON.stringify(c.localIdentifier)},
    taxonCanonical: ${JSON.stringify(c.taxon)},
    sourceFixCount: ${c.fullCount},
    fixes: [
${fixLines}
    ],
  },`;
  }).join("\n");
  return head + body + "\n};\n";
}

async function main() {
  const caps = [];
  for (const t of TARGETS) {
    const c = await capture(t);
    caps.push(c);
    console.log(`${c.key.padEnd(15)} ${c.role.padEnd(17)} "${c.localIdentifier}" ${c.taxon} src=${c.fullCount} -> ${c.fixes.length}pts`);
  }
  const capturedAt = Math.max(...caps.filter((c) => c.role === "LIVE").map((c) => c.lastTs));
  await writeFile(OUT, tsModule(caps, capturedAt));
  console.log(`\nCAPTURED_AT = ${capturedAt} (${new Date(capturedAt).toISOString()})`);
  console.log(`wrote ${OUT}`);
}

main().catch((e) => { console.error("FAILED", e); process.exit(1); });
