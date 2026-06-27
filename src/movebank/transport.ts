/**
 * Transports: the only part of the Movebank layer that touches the outside
 * world. Everything semantic (error taxonomy, license handshake, normalization)
 * lives in the client and is exercised against the FixtureTransport in tests.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { MovebankRequest, RawResponse, Transport } from "./types.ts";

/** Stable, human-legible key for a request — also the fixture file path. */
export function fixtureKey(req: MovebankRequest): string {
  const p = req.params;
  const accepted = req.licenseMd5 ? ".accepted" : "";
  switch (req.op) {
    case "list-studies":
      return `list-studies/all`;
    case "list-individuals":
      return `list-individuals/${p.studyId ?? "unknown"}`;
    case "get-locations": {
      const id = p.individualId ?? p.localIdentifier ?? "unknown";
      return `get-locations/${id}${accepted}`;
    }
  }
}

/**
 * Reads recorded JSON from a fixtures directory. A missing fixture surfaces as
 * a 404, which the client maps to a no-data result — exactly how the live
 * service behaves for an empty range.
 */
export class FixtureTransport implements Transport {
  private readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
  }

  async execute(req: MovebankRequest): Promise<RawResponse> {
    const path = join(this.dir, `${fixtureKey(req)}.json`);
    try {
      const text = await readFile(path, "utf8");
      return { status: 200, json: JSON.parse(text) };
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        return { status: 404, json: { message: "no fixture (empty range)" } };
      }
      throw err;
    }
  }
}

export interface LiveTransportOptions {
  apiBase: string;
  publicBase: string;
  accessToken?: string | undefined;
  /**
   * Sensor type for public-JSON reads. REQUIRED by the live service — omitting
   * it returns HTTP 500, not an empty result (validated against the live API).
   */
  defaultSensorType?: string;
  /** Injected for testability; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Builds real URLs for both surfaces and fetches them. URL/param shapes follow
 * the documented endpoints (brief §2.1). Marker/field names that the client
 * keys on should be validated against the live service before production — see
 * the client's `interpret` for the exact contract this assumes.
 */
export class LiveTransport implements Transport {
  private readonly opts: LiveTransportOptions;
  private readonly fetchImpl: typeof fetch;
  constructor(opts: LiveTransportOptions) {
    this.opts = opts;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async execute(req: MovebankRequest): Promise<RawResponse> {
    const url = this.buildUrl(req);
    const res = await this.fetchImpl(url, {
      headers: { Accept: "application/json" },
    });
    let json: unknown = null;
    const text = await res.text();
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // Non-JSON body (e.g. an HTML error or a raw license-terms page).
      json = { nonJsonBody: text };
    }
    return { status: res.status, json };
  }

  private buildUrl(req: MovebankRequest): string {
    const p = req.params;
    if (req.surface === "v2-rest") {
      const base = this.opts.apiBase.replace(/\/$/, "");
      const q = new URLSearchParams();
      if (this.opts.accessToken) q.set("access_token", this.opts.accessToken);
      if (req.licenseMd5) q.set("license-md5", req.licenseMd5);
      let path: string;
      switch (req.op) {
        case "list-studies":
          path = `/studies`;
          break;
        case "list-individuals":
          path = `/study-ids/${encodeURIComponent(p.studyId!)}/individuals`;
          break;
        case "get-locations":
          path = `/individuals/${encodeURIComponent(p.individualId!)}/locations`;
          if (p.start) q.set("start_date", p.start);
          if (p.end) q.set("end_date", p.end);
          break;
      }
      const qs = q.toString();
      return `${base}${path}${qs ? `?${qs}` : ""}`;
    }

    // public-json surface
    const q = new URLSearchParams();
    if (req.licenseMd5) q.set("license-md5", req.licenseMd5);
    // sensor_type is mandatory for data reads on the public JSON service.
    const sensorType = p.sensorType ?? this.opts.defaultSensorType ?? "gps";
    switch (req.op) {
      case "list-studies":
        q.set("entity_type", "study");
        break;
      case "list-individuals":
        q.set("study_id", p.studyId!);
        q.set("sensor_type", sensorType);
        break;
      case "get-locations":
        q.set("study_id", p.studyId!);
        q.set("sensor_type", sensorType);
        if (p.localIdentifier) q.set("individual_local_identifiers", p.localIdentifier);
        if (p.start) q.set("timestamp_start", p.start);
        if (p.end) q.set("timestamp_end", p.end);
        break;
    }
    return `${this.opts.publicBase}?${q.toString()}`;
  }
}
