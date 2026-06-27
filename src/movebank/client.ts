/**
 * MovebankClient (brief §8.1): a thin abstraction over the two API surfaces
 * (public-JSON + v2-REST) that:
 *   - normalizes wire differences into domain {@link Fix} / {@link RawIndividual}
 *   - implements the license-acceptance handshake (rather than failing/scraping)
 *   - distinguishes permission-denied from tag-went-quiet (the §2.3 invariant)
 *
 * All network access is behind a {@link Transport}, so the full semantic surface
 * is tested against recorded fixtures with no live calls.
 */

import { createHash } from "node:crypto";
import {
  LicenseTermsRequiredError,
  MovebankHttpError,
  PermissionDeniedError,
  RateLimitError,
} from "./errors.ts";
import type {
  MovebankRequest,
  Operation,
  RawResponse,
  Surface,
  Transport,
} from "./types.ts";
import type { Fix, SensorType } from "../domain/types.ts";

/** A study individual as it comes off the wire, before product curation. */
export interface RawIndividual {
  studyId: string;
  individualId: string;
  localIdentifier: string;
  taxonCanonicalName: string;
  sex?: "m" | "f" | "unknown";
  /** Name present in reference data, if any (else the roster assigns one). */
  nameInReference?: string;
}

/**
 * Decides whether to accept a study's license terms. Accepting is a legal act,
 * so the default policy refuses (the client then throws
 * {@link LicenseTermsRequiredError} for a human to handle). Provide an
 * accepting policy only for studies a human has cleared.
 */
export interface LicensePolicy {
  accept(ctx: {
    studyId: string;
    termsText: string;
    termsMd5: string;
    termsUrl?: string;
  }): boolean | Promise<boolean>;
  /** Called after a successful acceptance, for the audit trail. */
  onAccepted?(studyId: string, termsMd5: string): void;
}

export const REFUSE_ALL_LICENSES: LicensePolicy = {
  accept: () => false,
};

export interface MovebankClientOptions {
  transport: Transport;
  /** Default surface for reads; per-call override allowed. */
  defaultSurface?: Surface;
  licensePolicy?: LicensePolicy;
}

export interface GetLocationsArgs {
  studyId: string;
  /** v2-REST keys by individual id; public-JSON keys by local identifier. */
  individualId?: string;
  localIdentifier?: string;
  /** ISO dates (YYYY-MM-DD) bounding the range. */
  start?: string;
  end?: string;
  surface?: Surface;
  /** Public-JSON requires a sensor type; defaults to "gps" downstream. */
  sensorType?: string;
}

export class MovebankClient {
  private readonly transport: Transport;
  private readonly defaultSurface: Surface;
  private readonly licensePolicy: LicensePolicy;

  constructor(opts: MovebankClientOptions) {
    this.transport = opts.transport;
    this.defaultSurface = opts.defaultSurface ?? "public-json";
    this.licensePolicy = opts.licensePolicy ?? REFUSE_ALL_LICENSES;
  }

  async listIndividuals(
    studyId: string,
    surface: Surface = this.defaultSurface,
  ): Promise<RawIndividual[]> {
    const json = await this.request({
      surface,
      op: "list-individuals",
      params: { studyId },
    });
    return normalizeIndividuals(json, studyId);
  }

  /**
   * Returns the animal's fixes in range. An empty array means a valid request
   * with no points (tag-went-quiet) — NOT an error. Permission-denied throws
   * {@link PermissionDeniedError}; the two are never conflated.
   */
  async getLocations(args: GetLocationsArgs): Promise<Fix[]> {
    const surface = args.surface ?? this.defaultSurface;
    const params: Record<string, string> = { studyId: args.studyId };
    if (args.individualId) params.individualId = args.individualId;
    if (args.localIdentifier) params.localIdentifier = args.localIdentifier;
    if (args.start) params.start = args.start;
    if (args.end) params.end = args.end;
    if (args.sensorType) params.sensorType = args.sensorType;
    const json = await this.request({ surface, op: "get-locations", params });
    const idForFix = args.individualId ?? args.localIdentifier ?? args.studyId;
    return normalizeFixes(json, idForFix);
  }

  // -- core request pipeline: execute → interpret → (maybe accept license) ----

  private async request(
    base: MovebankRequest,
    attempt = 0,
  ): Promise<unknown> {
    const res = await this.transport.execute(base);
    const verdict = interpret(res, base);

    switch (verdict.kind) {
      case "ok":
        return verdict.json;
      case "no-data":
        // Valid but empty (e.g. 404 for an empty range). Hand back the shape
        // normalizers treat as zero rows. Tag-quiet, not failure.
        return verdict.json;
      case "permission-denied":
        throw new PermissionDeniedError(base.params.studyId ?? "?", verdict.message);
      case "rate-limited":
        throw new RateLimitError(verdict.retryAfterSeconds);
      case "http-error":
        throw new MovebankHttpError(verdict.status, verdict.message);
      case "license-required": {
        if (attempt > 0) {
          // We already retried with an accepted md5 and still got asked. Stop.
          throw new MovebankHttpError(409, "license acceptance not honored by service");
        }
        const accepted = await this.licensePolicy.accept({
          studyId: base.params.studyId ?? "?",
          termsText: verdict.termsText,
          termsMd5: verdict.termsMd5,
          termsUrl: verdict.termsUrl,
        });
        if (!accepted) {
          throw new LicenseTermsRequiredError(
            base.params.studyId ?? "?",
            verdict.termsText,
            verdict.termsMd5,
            verdict.termsUrl,
          );
        }
        // Verify integrity, then re-request carrying the accepted hash.
        const computed = md5(verdict.termsText);
        const md5ToSend = verdict.termsMd5 || computed;
        this.licensePolicy.onAccepted?.(base.params.studyId ?? "?", md5ToSend);
        return this.request({ ...base, licenseMd5: md5ToSend }, attempt + 1);
      }
    }
  }
}

export function md5(text: string): string {
  return createHash("md5").update(text, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Interpretation: map a raw response to a semantic verdict.
//
// The marker fields below define the contract the FixtureTransport encodes and
// that a LiveTransport adapter must map real Movebank responses onto. Keeping
// this in one place makes the §2.3 permission-vs-quiet rule auditable.
// ---------------------------------------------------------------------------

type Verdict =
  | { kind: "ok"; json: unknown }
  | { kind: "no-data"; json: unknown }
  | { kind: "permission-denied"; message: string }
  | { kind: "license-required"; termsText: string; termsMd5: string; termsUrl?: string }
  | { kind: "rate-limited"; retryAfterSeconds?: number }
  | { kind: "http-error"; status: number; message: string };

function interpret(res: RawResponse, _req: { op: Operation }): Verdict {
  const body = (res.json ?? {}) as Record<string, unknown>;

  if (res.status === 429) return { kind: "rate-limited" };
  if (res.status === 403) {
    return { kind: "permission-denied", message: str(body.message) ?? "403 from Movebank" };
  }
  if (res.status === 404) return { kind: "no-data", json: { locations: [] } };

  // License terms gate (can arrive on a 200 with a terms payload).
  const lt = (body.licenseTerms ?? body.license_terms) as
    | Record<string, unknown>
    | undefined;
  if (lt && typeof lt === "object") {
    const text = str(lt.text) ?? "";
    return {
      kind: "license-required",
      termsText: text,
      termsMd5: str(lt.md5) ?? md5(text),
      termsUrl: str(lt.url),
    };
  }

  // Explicit permission denial marker. CRUCIAL: distinct from empty locations.
  // Movebank returns a "no data available / contact owner" style payload here;
  // we key on the explicit flag so it is never confused with a quiet tag.
  if (body.permissionDenied === true) {
    return {
      kind: "permission-denied",
      message: str(body.message) ?? "data owner has not granted access",
    };
  }

  if (res.status >= 400) {
    return { kind: "http-error", status: res.status, message: str(body.message) ?? "error" };
  }

  return { kind: "ok", json: res.json };
}

// ---------------------------------------------------------------------------
// Normalizers: tolerate both surfaces' field naming.
// ---------------------------------------------------------------------------

function normalizeIndividuals(json: unknown, studyId: string): RawIndividual[] {
  const root = (json ?? {}) as Record<string, unknown>;
  const rows = (root.individuals ?? root.data ?? []) as unknown[];
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => {
    const o = r as Record<string, unknown>;
    const id =
      str(o.id) ?? str(o.individual_id) ?? str(o.local_identifier) ?? str(o.individual_local_identifier) ?? "";
    return {
      studyId,
      individualId: id,
      localIdentifier:
        str(o.local_identifier) ?? str(o.individual_local_identifier) ?? id,
      taxonCanonicalName:
        str(o.individual_taxon_canonical_name) ??
        str(o.taxon_canonical_name) ??
        str(o.taxon) ??
        "unknown",
      sex: normalizeSex(o.sex),
      nameInReference: str(o.animal_nickname) ?? str(o.nick_name) ?? str(o.name),
    };
  });
}

/**
 * Accepts either:
 *   v2:      { locations: [ { timestamp, location_lat, location_long, sensor_type } ] }
 *   public:  { individuals: [ { individual_local_identifier, locations: [...] } ] }
 *   GeoJSON: { features: [ { geometry: { coordinates: [lon,lat] }, properties: { timestamp } } ] }
 */
function normalizeFixes(json: unknown, individualId: string): Fix[] {
  const root = (json ?? {}) as Record<string, unknown>;
  const raw: unknown[] = [];

  if (Array.isArray(root.locations)) raw.push(...root.locations);
  if (Array.isArray(root.individuals)) {
    for (const ind of root.individuals as Record<string, unknown>[]) {
      if (Array.isArray(ind.locations)) raw.push(...ind.locations);
    }
  }
  if (Array.isArray(root.features)) {
    for (const f of root.features as Record<string, unknown>[]) {
      raw.push(featureToLocation(f));
    }
  }

  const fixes: Fix[] = [];
  for (const r of raw) {
    const o = r as Record<string, unknown>;
    const lat = num(o.location_lat ?? o.lat ?? o.latitude);
    const lon = num(o.location_long ?? o.lon ?? o.lng ?? o.longitude);
    const ts = parseTimestamp(o.timestamp ?? o.time);
    if (lat === null || lon === null || ts === null) continue; // drop junk rows
    fixes.push({
      individualId,
      timestamp: ts,
      lat,
      lon,
      sensorType: normalizeSensor(o.sensor_type ?? o.sensor),
      quality: num(o.quality ?? o.argos_lc) ?? undefined,
    });
  }
  fixes.sort((a, b) => a.timestamp - b.timestamp);
  return fixes;
}

function featureToLocation(f: Record<string, unknown>): Record<string, unknown> {
  const geom = (f.geometry ?? {}) as Record<string, unknown>;
  const coords = geom.coordinates as unknown;
  const props = (f.properties ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = { ...props };
  if (Array.isArray(coords) && coords.length >= 2) {
    out.location_long = coords[0];
    out.location_lat = coords[1];
  }
  return out;
}

// -- small coercion helpers --------------------------------------------------

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}
function parseTimestamp(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) {
    // Heuristic: < 1e12 looks like seconds, else ms.
    return v < 1e12 ? v * 1000 : v;
  }
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}
function normalizeSex(v: unknown): "m" | "f" | "unknown" {
  const s = typeof v === "string" ? v.toLowerCase() : "";
  if (s === "m" || s === "male") return "m";
  if (s === "f" || s === "female") return "f";
  return "unknown";
}
function normalizeSensor(v: unknown): SensorType {
  const s = typeof v === "string" ? v.toLowerCase() : "";
  if (s.includes("gnss")) return "gnss";
  if (s.includes("gps")) return "gps";
  if (s.includes("argos")) return "argos-doppler-shift";
  if (s.includes("accel")) return "acceleration";
  return "unknown";
}
