import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  MovebankClient,
  REFUSE_ALL_LICENSES,
  md5,
  type LicensePolicy,
} from "../src/movebank/client.ts";
import { FixtureTransport } from "../src/movebank/transport.ts";
import {
  LicenseTermsRequiredError,
  PermissionDeniedError,
} from "../src/movebank/errors.ts";

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "movebank",
);

function client(policy: LicensePolicy = REFUSE_ALL_LICENSES) {
  return new MovebankClient({
    transport: new FixtureTransport(FIXTURES),
    defaultSurface: "v2-rest",
    licensePolicy: policy,
  });
}

test("listIndividuals normalizes both named and unnamed animals", async () => {
  const inds = await client().listIndividuals("STUDY_TEST");
  assert.equal(inds.length, 2);
  const aila = inds.find((i) => i.individualId === "IND_LIVE")!;
  assert.equal(aila.taxonCanonicalName, "Ciconia ciconia");
  assert.equal(aila.sex, "f");
  assert.equal(aila.nameInReference, "Aila");

  const noname = inds.find((i) => i.individualId === "IND_NONAME")!;
  assert.equal(noname.nameInReference, undefined, "no fabricated name from client");
  assert.equal(noname.localIdentifier, "DER A1002");
});

test("getLocations returns fixes sorted ascending by time", async () => {
  const fixes = await client().getLocations({
    studyId: "STUDY_TEST",
    individualId: "IND_LIVE",
  });
  assert.equal(fixes.length, 3);
  for (let i = 1; i < fixes.length; i++) {
    assert.ok(fixes[i]!.timestamp >= fixes[i - 1]!.timestamp, "ascending");
  }
  assert.equal(fixes[0]!.sensorType, "gps");
  assert.equal(fixes[2]!.sensorType, "gnss");
  assert.equal(fixes[0]!.quality, 3, "quality survives normalization (earliest fix)");
});

test("tag-went-quiet returns an EMPTY array, not an error", async () => {
  const fixes = await client().getLocations({
    studyId: "STUDY_TEST",
    individualId: "IND_QUIET",
  });
  assert.deepEqual(fixes, []);
});

test("permission-denied THROWS — never conflated with quiet", async () => {
  await assert.rejects(
    () => client().getLocations({ studyId: "STUDY_TEST", individualId: "IND_DENIED" }),
    (err: unknown) => {
      assert.ok(err instanceof PermissionDeniedError);
      assert.equal((err as PermissionDeniedError).studyId, "STUDY_TEST");
      return true;
    },
  );
});

test("the §2.3 invariant: quiet and denied produce categorically different outcomes", async () => {
  const quiet = await client().getLocations({ studyId: "STUDY_TEST", individualId: "IND_QUIET" });
  assert.deepEqual(quiet, []); // resolvable to QUIET narrative

  let denied = false;
  try {
    await client().getLocations({ studyId: "STUDY_TEST", individualId: "IND_DENIED" });
  } catch (e) {
    denied = e instanceof PermissionDeniedError; // resolvable to PERMISSION_LOST
  }
  assert.equal(denied, true);
});

test("license terms gate: default policy refuses and surfaces the terms", async () => {
  await assert.rejects(
    () => client().getLocations({ studyId: "STUDY_TEST", individualId: "IND_LICENSED" }),
    (err: unknown) => {
      assert.ok(err instanceof LicenseTermsRequiredError);
      const e = err as LicenseTermsRequiredError;
      assert.match(e.termsText, /Demo License Terms/);
      assert.equal(e.termsMd5, md5(e.termsText), "client computes the acceptance hash");
      return true;
    },
  );
});

test("license-acceptance handshake: accepting policy re-requests with the md5 and gets data", async () => {
  const accepted: Array<{ studyId: string; md5: string }> = [];
  const acceptingPolicy: LicensePolicy = {
    accept: ({ termsText }) => /non-commercial outreach/.test(termsText),
    onAccepted: (studyId, m) => accepted.push({ studyId, md5: m }),
  };
  const fixes = await client(acceptingPolicy).getLocations({
    studyId: "STUDY_TEST",
    individualId: "IND_LICENSED",
  });
  assert.equal(fixes.length, 1, "received data after accepting");
  assert.equal(accepted.length, 1, "acceptance was recorded for the audit trail");
  assert.equal(accepted[0]!.studyId, "STUDY_TEST");
});

test("public-JSON GeoJSON FeatureCollection normalizes to fixes", async () => {
  const fixes = await client().getLocations({
    studyId: "STUDY_TEST",
    individualId: "IND_GEO",
    surface: "public-json",
  });
  assert.equal(fixes.length, 2);
  // coordinates are [lon, lat] in GeoJSON — assert we didn't swap them.
  assert.ok(Math.abs(fixes[0]!.lat - 36.13) < 1e-6 || Math.abs(fixes[0]!.lat - 35.89) < 1e-6);
  assert.ok(fixes.every((f) => f.lon < 0 && f.lat > 0));
});

test("a missing fixture (empty range) is no-data, not a crash", async () => {
  const fixes = await client().getLocations({
    studyId: "STUDY_TEST",
    individualId: "DOES_NOT_EXIST",
  });
  assert.deepEqual(fixes, []);
});
