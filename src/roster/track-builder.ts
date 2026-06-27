/**
 * Deterministic synthetic-track generator for the offline demo roster.
 *
 * IMPORTANT (honesty, brief §5): these tracks are SYNTHETIC and clearly labelled
 * as such everywhere they surface. They exist so the continuity states and the
 * UI can be exercised offline. They are not real animal positions. Real
 * deployment replaces seeded fixtures with live MovebankClient reads.
 */

import { haversineKm, type LatLon } from "../domain/geo.ts";
import type { Fix, SensorType } from "../domain/types.ts";

export interface TrackSpec {
  individualId: string;
  /** Ordered waypoints describing the journey's shape. */
  waypoints: LatLon[];
  /** Epoch ms of the most recent fix. */
  endAt: number;
  /** Hours between fixes. */
  cadenceHours: number;
  /** Number of fixes to emit (>= 2). */
  count: number;
  sensorType?: SensorType;
}

/** Position at fraction `t` (0..1) along the waypoint polyline, by distance. */
function interpolateAlong(waypoints: LatLon[], t: number): LatLon {
  if (waypoints.length === 1) return waypoints[0]!;
  const segLen: number[] = [];
  let total = 0;
  for (let i = 1; i < waypoints.length; i++) {
    const d = haversineKm(waypoints[i - 1]!, waypoints[i]!);
    segLen.push(d);
    total += d;
  }
  if (total === 0) return waypoints[0]!;
  let target = t * total;
  for (let i = 0; i < segLen.length; i++) {
    if (target <= segLen[i]! || i === segLen.length - 1) {
      const f = segLen[i]! === 0 ? 0 : target / segLen[i]!;
      const a = waypoints[i]!;
      const b = waypoints[i + 1]!;
      return { lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f };
    }
    target -= segLen[i]!;
  }
  return waypoints[waypoints.length - 1]!;
}

/** Tiny deterministic jitter so tracks don't look laser-straight. */
function jitter(i: number): { dLat: number; dLon: number } {
  return { dLat: Math.sin(i * 1.7) * 0.05, dLon: Math.cos(i * 2.3) * 0.05 };
}

export function buildTrack(spec: TrackSpec): Fix[] {
  const n = Math.max(2, spec.count);
  const sensor = spec.sensorType ?? "gps";
  const fixes: Fix[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const pos = interpolateAlong(spec.waypoints, t);
    const j = jitter(i);
    fixes.push({
      individualId: spec.individualId,
      timestamp: spec.endAt - (n - 1 - i) * spec.cadenceHours * 3_600_000,
      lat: +(pos.lat + j.dLat).toFixed(5),
      lon: +(pos.lon + j.dLon).toFixed(5),
      sensorType: sensor,
    });
  }
  return fixes;
}
