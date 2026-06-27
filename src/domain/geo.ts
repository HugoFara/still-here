/** Pure geo helpers. No I/O. Shared by scoring, narrative, and the UI. */

import type { Fix } from "./types.ts";

export interface LatLon {
  lat: number;
  lon: number;
}

const R_KM = 6371;
const toRad = (d: number): number => (d * Math.PI) / 180;

/** Great-circle distance between two points, in kilometres. */
export function haversineKm(a: LatLon, b: LatLon): number {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Total path length along a time-ordered track. */
export function pathLengthKm(fixes: Fix[]): number {
  let sum = 0;
  for (let i = 1; i < fixes.length; i++) sum += haversineKm(fixes[i - 1]!, fixes[i]!);
  return sum;
}

/** Straight-line distance from first to last fix. */
export function netDisplacementKm(fixes: Fix[]): number {
  if (fixes.length < 2) return 0;
  return haversineKm(fixes[0]!, fixes[fixes.length - 1]!);
}

/** Minimum distance from any fix to a reference point (e.g. the user's city). */
export function minDistanceToKm(fixes: Fix[], ref: LatLon): number {
  let min = Infinity;
  for (const f of fixes) min = Math.min(min, haversineKm(f, ref));
  return Number.isFinite(min) ? min : Infinity;
}

export interface BBox {
  minLat: number;
  minLon: number;
  maxLat: number;
  maxLon: number;
}

export function boundingBox(fixes: Fix[]): BBox | null {
  if (fixes.length === 0) return null;
  let minLat = Infinity, minLon = Infinity, maxLat = -Infinity, maxLon = -Infinity;
  for (const f of fixes) {
    minLat = Math.min(minLat, f.lat);
    maxLat = Math.max(maxLat, f.lat);
    minLon = Math.min(minLon, f.lon);
    maxLon = Math.max(maxLon, f.lon);
  }
  return { minLat, minLon, maxLat, maxLon };
}

/** Compass bearing (degrees, 0=N) from a→b. */
export function bearingDeg(a: LatLon, b: LatLon): number {
  const y = Math.sin(toRad(b.lon - a.lon)) * Math.cos(toRad(b.lat));
  const x =
    Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) -
    Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lon - a.lon));
  return (Math.atan2(y, x) * 180) / Math.PI;
}

/** "south", "north-east", etc. for a bearing. Used in narrative framing. */
export function compass(bearing: number): string {
  const dirs = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"];
  const idx = Math.round(((bearing % 360) + 360) % 360 / 45) % 8;
  return dirs[idx]!;
}
