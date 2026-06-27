/**
 * Reverse-geocoder abstraction (brief §6 mentions reverse-geocode for place
 * names). The offline {@link GazetteerGeocoder} is the default the pure grounding
 * path uses; {@link NominatimGeocoder} is the production swap.
 *
 * Both return the same {@link PlaceDescription} shape so the narrative layer is
 * agnostic. Nominatim is async (network) and rate-limited, so in production you
 * resolve names during ingestion and persist them, keeping grounding pure/sync.
 */

import { describeLocation, type Place, type PlaceDescription } from "./places.ts";
import type { LatLon } from "./geo.ts";

export interface Geocoder {
  readonly id: string;
  describe(point: LatLon): PlaceDescription | Promise<PlaceDescription>;
}

/** Offline, deterministic, zero-network. The default. */
export class GazetteerGeocoder implements Geocoder {
  readonly id = "gazetteer";
  private readonly gazetteer: Place[] | undefined;
  constructor(gazetteer?: Place[]) {
    this.gazetteer = gazetteer;
  }
  describe(point: LatLon): PlaceDescription {
    return this.gazetteer ? describeLocation(point, this.gazetteer) : describeLocation(point);
  }
}

export interface NominatimOptions {
  /** Nominatim requires a descriptive User-Agent / contact (their usage policy). */
  userAgent: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Coordinate rounding (decimal places) for the cache key — caps request rate. */
  cachePrecision?: number;
  /** "near" threshold in km, mirroring the gazetteer's semantics. */
  nearKm?: number;
}

/**
 * Live reverse-geocoding via OpenStreetMap Nominatim. Caches by rounded coord to
 * respect the 1 req/s usage policy and avoid re-querying nearby fixes.
 */
export class NominatimGeocoder implements Geocoder {
  readonly id = "nominatim";
  private readonly opts: Required<Omit<NominatimOptions, "fetchImpl">>;
  private readonly fetchImpl: typeof fetch;
  private readonly cache = new Map<string, PlaceDescription>();

  constructor(opts: NominatimOptions) {
    this.opts = {
      userAgent: opts.userAgent,
      baseUrl: opts.baseUrl ?? "https://nominatim.openstreetmap.org",
      cachePrecision: opts.cachePrecision ?? 2,
      nearKm: opts.nearKm ?? 75,
    };
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async describe(point: LatLon): Promise<PlaceDescription> {
    const key = `${point.lat.toFixed(this.opts.cachePrecision)},${point.lon.toFixed(this.opts.cachePrecision)}`;
    const cached = this.cache.get(key);
    if (cached) return cached;

    const url =
      `${this.opts.baseUrl}/reverse?format=jsonv2&lat=${point.lat}&lon=${point.lon}&zoom=10`;
    const res = await this.fetchImpl(url, { headers: { "User-Agent": this.opts.userAgent } });
    if (!res.ok) throw new Error(`Nominatim error ${res.status}`);
    const data = (await res.json()) as {
      name?: string;
      display_name?: string;
      address?: Record<string, string>;
    };

    const addr = data.address ?? {};
    const name =
      data.name ||
      addr.city || addr.town || addr.village || addr.county ||
      (data.display_name ? data.display_name.split(",")[0] : undefined) ||
      "an unnamed place";
    const region = addr.state || addr.country || "";

    const place: Place = { name, region, lat: point.lat, lon: point.lon };
    // A reverse hit is, by construction, the nearest named place to the point.
    const desc: PlaceDescription = { place, distanceKm: 0, near: true };
    this.cache.set(key, desc);
    return desc;
  }
}
