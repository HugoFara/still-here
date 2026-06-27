import { test } from "node:test";
import assert from "node:assert/strict";
import { GazetteerGeocoder, NominatimGeocoder } from "../src/domain/geocode.ts";

test("GazetteerGeocoder resolves a coordinate to the nearest named place (offline)", async () => {
  const g = new GazetteerGeocoder();
  const d = await g.describe({ lat: 46.46, lon: 6.6 }); // on Lake Geneva
  assert.equal(d.place.name, "Lake Geneva");
  assert.equal(d.near, true);
});

test("NominatimGeocoder parses a reverse response and sends a User-Agent", async () => {
  const calls: Array<{ url: string; ua: string | undefined }> = [];
  const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      ua: (init?.headers as Record<string, string> | undefined)?.["User-Agent"],
    });
    return new Response(
      JSON.stringify({
        name: "Tarifa",
        display_name: "Tarifa, Cádiz, Andalusia, Spain",
        address: { town: "Tarifa", state: "Andalusia", country: "Spain" },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;

  const g = new NominatimGeocoder({ userAgent: "still-here/0.1 (test@example.org)", fetchImpl: fakeFetch });
  const d = await g.describe({ lat: 36.013, lon: -5.606 });
  assert.equal(d.place.name, "Tarifa");
  assert.equal(d.place.region, "Andalusia");
  assert.equal(d.near, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.ua ?? "", /still-here/, "Nominatim usage policy requires a UA");
});

test("NominatimGeocoder caches by rounded coordinate to respect rate limits", async () => {
  let n = 0;
  const fakeFetch = (async () => {
    n++;
    return new Response(JSON.stringify({ name: "X", address: { country: "Y" } }), { status: 200 });
  }) as unknown as typeof fetch;
  const g = new NominatimGeocoder({ userAgent: "ua", fetchImpl: fakeFetch, cachePrecision: 2 });
  await g.describe({ lat: 36.0121, lon: -5.6063 });
  await g.describe({ lat: 36.0119, lon: -5.6061 }); // rounds to same key
  assert.equal(n, 1, "second nearby lookup served from cache");
});
