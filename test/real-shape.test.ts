import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { MovebankClient } from "../src/movebank/client.ts";
import type { MovebankRequest, RawResponse, Transport } from "../src/movebank/types.ts";

/**
 * Regression guard against the REAL Movebank public JSON shape, captured live
 * from the fully-public Galapagos Albatrosses study (id 2911040) on 2026-06-27:
 *   { individuals: [ { individual_local_identifier, individual_taxon_canonical_name,
 *                      locations: [ { timestamp (ms), location_long, location_lat } ] } ] }
 * If Movebank's contract drifts or our normalizer regresses, this fails.
 */
const REAL = JSON.parse(
  readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "fixtures",
      "movebank",
      "real",
      "galapagos-albatross-public-json.json",
    ),
    "utf8",
  ),
);

class CannedTransport implements Transport {
  private readonly body: unknown;
  constructor(body: unknown) {
    this.body = body;
  }
  async execute(_req: MovebankRequest): Promise<RawResponse> {
    return { status: 200, json: this.body };
  }
}

test("client parses the real Movebank public-JSON locations shape", async () => {
  const client = new MovebankClient({
    transport: new CannedTransport(REAL),
    defaultSurface: "public-json",
  });
  const fixes = await client.getLocations({ studyId: "2911040", sensorType: "gps" });

  assert.ok(fixes.length >= 4, "flattens locations across individuals");
  // Coordinates not swapped: Galapagos is ~ (-1.39 lat, -89.62 lon).
  for (const f of fixes) {
    assert.ok(f.lat < 0 && f.lat > -2, `lat in Galapagos range, got ${f.lat}`);
    assert.ok(f.lon < -89 && f.lon > -91, `lon in Galapagos range, got ${f.lon}`);
    assert.ok(f.timestamp > 1.2e12, "ms epoch timestamp parsed");
  }
  // Ascending by time.
  for (let i = 1; i < fixes.length; i++) {
    assert.ok(fixes[i]!.timestamp >= fixes[i - 1]!.timestamp);
  }
});

test("permission-vs-quiet still holds on the real-derived path (empty individuals)", async () => {
  const client = new MovebankClient({
    transport: new CannedTransport({ individuals: [] }),
    defaultSurface: "public-json",
  });
  const fixes = await client.getLocations({ studyId: "2911040" });
  assert.deepEqual(fixes, [], "no individuals → empty, not an error");
});
