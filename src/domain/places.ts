/**
 * Offline reverse-geocoding via a small hand-curated gazetteer of waypoints
 * along the European/African flyways this roster uses.
 *
 * Grounding (brief §6): the narrative generator only ever speaks place names
 * that come from real coordinates resolved here. In production, swap
 * {@link describeLocation} for a real reverse-geocoder (e.g. Nominatim); the
 * gazetteer keeps the offline slice fully grounded and deterministic.
 */

import { haversineKm, type LatLon } from "./geo.ts";

export interface Place {
  name: string;
  /** Coarse region for framing ("breeding grounds", "the Sahel", etc.). */
  region: string;
  lat: number;
  lon: number;
  /** Notable feature flag used to add colour ("crossed the Strait..."). */
  landmark?: boolean;
}

/** Waypoints relevant to the seed roster's flyways. */
export const GAZETTEER: Place[] = [
  { name: "Lake Constance", region: "southern Germany", lat: 47.66, lon: 9.18 },
  { name: "Lake Geneva", region: "Switzerland", lat: 46.45, lon: 6.6 },
  { name: "the Camargue", region: "southern France", lat: 43.53, lon: 4.42 },
  { name: "the Ebro Delta", region: "Catalonia", lat: 40.72, lon: 0.73 },
  { name: "Madrid", region: "central Spain", lat: 40.42, lon: -3.7 },
  { name: "Extremadura", region: "western Spain", lat: 39.2, lon: -6.1 },
  { name: "Doñana", region: "Andalusia", lat: 37.0, lon: -6.45 },
  { name: "the Strait of Gibraltar", region: "between Europe and Africa", lat: 35.95, lon: -5.6, landmark: true },
  { name: "Tangier", region: "northern Morocco", lat: 35.76, lon: -5.83 },
  { name: "the Atlas foothills", region: "Morocco", lat: 32.1, lon: -6.0 },
  { name: "the western Sahara", region: "the Sahara", lat: 25.0, lon: -10.0 },
  { name: "the Senegal River", region: "the Sahel", lat: 16.5, lon: -15.5 },
  { name: "the Djoudj wetlands", region: "northern Senegal", lat: 16.4, lon: -16.2 },
  { name: "Orbetello lagoon", region: "Tuscany", lat: 42.44, lon: 11.2, landmark: true },
  { name: "the Apennines", region: "central Italy", lat: 43.5, lon: 11.8 },
  { name: "Burghausen", region: "Bavaria", lat: 48.17, lon: 12.83 },
  { name: "the Bosphorus", region: "Istanbul", lat: 41.1, lon: 29.05, landmark: true },
  { name: "the Nile Valley", region: "Egypt", lat: 27.0, lon: 31.2 },
  { name: "the Rutland reservoirs", region: "the English Midlands", lat: 52.65, lon: -0.63 },
  { name: "the Bay of Biscay coast", region: "western France", lat: 45.6, lon: -1.1 },

  // Waypoints added for the verified real roster (Louis, Noé, Mistral, the honey
  // buzzard, Rosel, Europa, the Swiss kite). Each maps a region the real tracks
  // actually pass through, so grounded place names stay accurate rather than
  // snapping to a distant flyway point.
  { name: "Strasbourg", region: "Alsace", lat: 48.58, lon: 7.75 },
  { name: "Sarralbe", region: "Lorraine", lat: 48.99, lon: 6.99 },
  { name: "the Vosges", region: "eastern France", lat: 48.2, lon: 7.0 },
  { name: "the Upper Rhine plain", region: "around Karlsruhe", lat: 49.0, lon: 8.4 },
  { name: "the Black Forest", region: "Baden-Württemberg", lat: 48.0, lon: 8.2 },
  { name: "the Swabian Alb", region: "around Stuttgart", lat: 48.5, lon: 9.3 },
  { name: "Bern", region: "the Swiss plateau", lat: 46.95, lon: 7.45 },
  { name: "the Rhône valley", region: "southeastern France", lat: 44.5, lon: 4.8 },
  { name: "the Gulf of Lion", region: "the French Mediterranean coast", lat: 43.2, lon: 3.7 },
  { name: "Menorca", region: "the Balearic Islands", lat: 39.9, lon: 4.25 },
  { name: "the Pyrenees", region: "the French–Spanish border", lat: 42.7, lon: 0.9, landmark: true },
  { name: "the Segrià plain", region: "Catalonia", lat: 41.62, lon: 0.62 },
  { name: "the Ebro basin", region: "around Zaragoza", lat: 41.65, lon: -0.9 },
  { name: "the Guadalquivir marshes", region: "Andalusia", lat: 37.2, lon: -5.9 },
  { name: "the Atlantic coast of Morocco", region: "Morocco", lat: 34.0, lon: -6.6 },
  { name: "the Banc d'Arguin", region: "Mauritania", lat: 20.0, lon: -16.3 },
  { name: "the Guinea coast", region: "West Africa", lat: 9.0, lon: -13.0 },
];

export interface PlaceDescription {
  /** Nearest gazetteer place. */
  place: Place;
  /** Distance in km to that place (how loosely "near" is meant). */
  distanceKm: number;
  /** True when within ~75 km — close enough to name confidently. */
  near: boolean;
}

/** Resolve a coordinate to the nearest known place. Always grounded. */
export function describeLocation(point: LatLon, gazetteer: Place[] = GAZETTEER): PlaceDescription {
  let best = gazetteer[0]!;
  let bestKm = haversineKm(point, best);
  for (const p of gazetteer) {
    const d = haversineKm(point, p);
    if (d < bestKm) {
      best = p;
      bestKm = d;
    }
  }
  return { place: best, distanceKm: bestKm, near: bestKm <= 75 };
}
