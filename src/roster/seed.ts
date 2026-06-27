/**
 * Hand-curated seed roster (brief §4): 7 European/Eurasian migratory individuals
 * chosen to (a) collapse distance toward a Geneva user and (b) exercise EVERY
 * continuity state so the §5 engine and the UI can be demonstrated offline.
 *
 * HONESTY: provenance.verified is false for all of them and the tracks are
 * SYNTHETIC. Study names reference the real public Movebank study families these
 * are modelled on, but PIs/licenses/DOIs are placeholders a human MUST verify
 * against live Movebank before showing anything as real. Nothing here should be
 * presented to an end user as a confirmed real-time position.
 */

import type {
  Fix,
  Individual,
  OwnerResolution,
  Provenance,
  Study,
} from "../domain/types.ts";
import type { LatLon } from "../domain/geo.ts";
import { buildTrack } from "./track-builder.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// Flyway waypoints (approx). See src/domain/places.ts for the matching gazetteer.
const W = {
  constance: { lat: 47.66, lon: 9.18 },
  camargue: { lat: 43.53, lon: 4.42 },
  ebro: { lat: 40.72, lon: 0.73 },
  extremadura: { lat: 39.2, lon: -6.1 },
  donana: { lat: 37.0, lon: -6.45 },
  gibraltar: { lat: 35.95, lon: -5.6 },
  tangier: { lat: 35.76, lon: -5.83 },
  senegal: { lat: 16.5, lon: -15.5 },
  geneva: { lat: 46.45, lon: 6.6 },
  burghausen: { lat: 48.17, lon: 12.83 },
  apennines: { lat: 43.5, lon: 11.8 },
  orbetello: { lat: 42.44, lon: 11.2 },
  rutland: { lat: 52.65, lon: -0.63 },
  biscay: { lat: 45.6, lon: -1.1 },
  bosphorus: { lat: 41.1, lon: 29.05 },
  nile: { lat: 27.0, lon: 31.2 },
  sahara: { lat: 25.0, lon: -10.0 },
} satisfies Record<string, LatLon>;

function provenance(over: Partial<Provenance> & { studyId: string; studyName: string }): Provenance {
  return {
    principalInvestigator: "Study PI (placeholder — verify on Movebank)",
    license: "CC BY-NC 4.0 (unverified placeholder)",
    licenseTermsUrl: "https://www.movebank.org/cms/movebank-content/data-policy",
    citation: "Synthetic demo — replace with the real study citation/DOI before use.",
    verified: false,
    ...over,
  };
}

export const SEED_STUDIES: Study[] = [
  {
    id: "study-stork",
    name: "LifeTrack White Stork (demo — synthetic track)",
    isPublic: true,
    studyType: "telemetry",
    provenance: provenance({ studyId: "study-stork", studyName: "LifeTrack White Stork (demo)" }),
  },
  {
    id: "study-osprey",
    name: "European Osprey Migration (demo — synthetic track)",
    isPublic: true,
    studyType: "telemetry",
    provenance: provenance({ studyId: "study-osprey", studyName: "European Osprey Migration (demo)" }),
  },
  {
    id: "study-ibis",
    name: "Waldrappteam Northern Bald Ibis reintroduction (demo — synthetic track)",
    isPublic: true,
    studyType: "telemetry",
    provenance: provenance({ studyId: "study-ibis", studyName: "Waldrappteam Northern Bald Ibis (demo)" }),
  },
  {
    id: "study-eagle",
    name: "LifeTrack Lesser Spotted Eagle (demo — synthetic track)",
    isPublic: true,
    studyType: "telemetry",
    provenance: provenance({ studyId: "study-eagle", studyName: "LifeTrack Lesser Spotted Eagle (demo)" }),
  },
  {
    // Public listing, but the per-animal data access is revoked at runtime to
    // demonstrate the PERMISSION_LOST → retire-silently path.
    id: "study-stork-private",
    name: "White Stork regional study (demo — access revoked at runtime)",
    isPublic: true,
    studyType: "telemetry",
    provenance: provenance({ studyId: "study-stork-private", studyName: "White Stork regional study (demo)" }),
  },
];

export interface SeedAnimal {
  individual: Individual;
  fixes: Fix[];
  ownerResolution?: OwnerResolution;
  /** When true, ingestion should receive a permission-denied response. */
  permissionLost?: boolean;
  /** Thematic group for successor handoff. */
  theme: string;
}

export interface SeedData {
  studies: Study[];
  animals: SeedAnimal[];
}

const BIRD = "european-migratory-bird";

/** Identity with a type annotation — forces each literal to satisfy Individual. */
const individual = (i: Individual): Individual => i;

/** Build the full seed anchored to `now` so continuity states are always fresh. */
export function buildSeed(now: number): SeedData {
  const animals: SeedAnimal[] = [
    // 1. LIVE — White Stork mid-migration toward the Strait of Gibraltar.
    {
      theme: BIRD,
      individual: individual({
        id: "stork-aila",
        studyId: "study-stork",
        localIdentifier: "DER AU041",
        taxon: { genus: "Ciconia", species: "ciconia", commonName: "White Stork" },
        name: "Aila",
        nameIsAssigned: false,
        sex: "f",
        referenceNotes: "Modelled on a juvenile white stork tagged near Lake Constance. Synthetic demo track.",
        expectedFixesPerWeek: 7,
      }),
      fixes: buildTrack({
        individualId: "stork-aila",
        waypoints: [W.constance, W.camargue, W.ebro, W.donana, W.gibraltar, W.tangier],
        endAt: now - 6 * HOUR,
        cadenceHours: 24,
        count: 55,
      }),
    },

    // 2. LIVE — Osprey heading for the Sahel.
    {
      theme: BIRD,
      individual: individual({
        id: "osprey-brennus",
        studyId: "study-osprey",
        localIdentifier: "OSP-2207",
        taxon: { genus: "Pandion", species: "haliaetus", commonName: "Osprey" },
        name: "Brennus",
        nameIsAssigned: false,
        sex: "m",
        referenceNotes: "Modelled on an English-breeding osprey wintering in West Africa. Synthetic demo track.",
        expectedFixesPerWeek: 7,
      }),
      fixes: buildTrack({
        individualId: "osprey-brennus",
        waypoints: [W.rutland, W.biscay, W.ebro, W.donana, W.gibraltar, W.senegal],
        endAt: now - 20 * HOUR,
        cadenceHours: 24,
        count: 48,
      }),
    },

    // 3. LIVE — Northern Bald Ibis passing close to the user (Lake Geneva).
    {
      theme: BIRD,
      individual: individual({
        id: "ibis-tara",
        studyId: "study-ibis",
        localIdentifier: "NBI-Tara",
        taxon: { genus: "Geronticus", species: "eremita", commonName: "Northern Bald Ibis" },
        name: "Tara",
        nameIsAssigned: false,
        sex: "f",
        referenceNotes: "Modelled on a reintroduced bald ibis migrating Bavaria→Tuscany past Lake Geneva. Synthetic demo track.",
        expectedFixesPerWeek: 7,
      }),
      fixes: buildTrack({
        individualId: "ibis-tara",
        waypoints: [W.burghausen, W.constance, W.geneva, W.apennines, W.orbetello],
        endAt: now - 10 * HOUR,
        cadenceHours: 24,
        count: 30,
      }),
    },

    // 4. QUIET — White Stork that has paused; last fix 6 days ago.
    {
      theme: BIRD,
      individual: individual({
        id: "stork-niko",
        studyId: "study-stork",
        localIdentifier: "DER AU058",
        taxon: { genus: "Ciconia", species: "ciconia", commonName: "White Stork" },
        name: "Niko",
        nameIsAssigned: false,
        sex: "m",
        referenceNotes: "Modelled on a white stork that has settled to feed in western Spain. Synthetic demo track.",
        expectedFixesPerWeek: 7,
      }),
      fixes: buildTrack({
        individualId: "stork-niko",
        waypoints: [W.constance, W.camargue, W.extremadura],
        endAt: now - 6 * DAY,
        cadenceHours: 24,
        count: 35,
      }),
    },

    // 5. RESOLVED_KNOWN — Osprey whose tag was recovered / deployment ended.
    {
      theme: BIRD,
      ownerResolution: {
        kind: "tag-removed",
        at: now - 10 * DAY,
        note: "Tag recovered in good condition; the study deployment for this bird ended.",
      },
      individual: individual({
        id: "osprey-skylla",
        studyId: "study-osprey",
        localIdentifier: "OSP-1991",
        taxon: { genus: "Pandion", species: "haliaetus", commonName: "Osprey" },
        name: "Skylla",
        nameIsAssigned: false,
        sex: "f",
        referenceNotes: "Modelled on an osprey whose tracker reached end-of-deployment in Andalusia. Synthetic demo track.",
        expectedFixesPerWeek: 7,
      }),
      fixes: buildTrack({
        individualId: "osprey-skylla",
        waypoints: [W.rutland, W.biscay, W.donana],
        endAt: now - 10 * DAY,
        cadenceHours: 24,
        count: 30,
      }),
    },

    // 6. RESOLVED_UNKNOWN — Eagle whose signal was lost over the Sahara.
    {
      theme: BIRD,
      individual: individual({
        id: "eagle-viljo",
        studyId: "study-eagle",
        localIdentifier: "LSE-Viljo",
        taxon: { genus: "Clanga", species: "pomarina", commonName: "Lesser Spotted Eagle" },
        name: "Viljo",
        nameIsAssigned: false,
        sex: "m",
        referenceNotes: "Modelled on a lesser spotted eagle crossing the Bosphorus toward Africa. Signal ended over the Sahara. Synthetic demo track.",
        expectedFixesPerWeek: 3.5,
      }),
      fixes: buildTrack({
        individualId: "eagle-viljo",
        waypoints: [W.bosphorus, W.nile, W.sahara],
        endAt: now - 40 * DAY,
        cadenceHours: 48,
        count: 25,
      }),
    },

    // 7. PERMISSION_LOST — recent fixes exist, but API access is revoked.
    {
      theme: BIRD,
      permissionLost: true,
      individual: individual({
        id: "stork-maud",
        studyId: "study-stork-private",
        localIdentifier: "DER AX002",
        taxon: { genus: "Ciconia", species: "ciconia", commonName: "White Stork" },
        name: "Maud",
        nameIsAssigned: false,
        sex: "f",
        referenceNotes: "Demonstrates permission-loss: the data owner revoked API access. Must retire silently, never shown as 'disappeared'. Synthetic demo track.",
        expectedFixesPerWeek: 7,
      }),
      fixes: buildTrack({
        individualId: "stork-maud",
        waypoints: [W.constance, W.camargue, W.donana],
        endAt: now - 2 * DAY,
        cadenceHours: 24,
        count: 30,
      }),
    },
  ];

  return { studies: SEED_STUDIES, animals };
}
