/**
 * Verified-candidate roster (brief §4), sourced from REAL Movebank data.
 *
 * Every track here is a genuine, unmodified Movebank snapshot of a real named
 * individual from a fully-public study (license terms suspended), captured
 * 2026-06-26 and downsampled for the offline build (see real-tracks.generated.ts).
 * The continuity states are NOT engineered — they fall out of each bird's real
 * last-fix recency against the capture instant:
 *
 *   Louis, Noé, Mistral, Pilgrim   LIVE              (reported within a day)
 *   Rosel                          QUIET             (genuinely silent 14 days)
 *   Europa                         RESOLVED_UNKNOWN  (silent 64 days, no resolution)
 *   Aare (Swiss kite)              RESOLVED_KNOWN    (study deployment ended 2022)
 *
 * PROVENANCE: confirmed 2026-06-28 against the authenticated Movebank
 * `direct-read` service, so all seven real individuals are now `verified: true`,
 * each carrying its owner-set license (CC0 / CC BY / CC BY-NC — note the kite is
 * non-commercial), PI and citation. This is DISTINCT from synthetic: only the one
 * PERMISSION_LOST demonstrator below is fabricated, because a public study cannot,
 * by definition, revoke your access.
 */

import type {
  Fix,
  Individual,
  OwnerResolution,
  Provenance,
  Study,
  Taxon,
} from "../domain/types.ts";
import { buildTrack } from "./track-builder.ts";
import { CAPTURED_AT, REAL_TRACKS } from "./real-tracks.generated.ts";

const HOUR = 3_600_000;

/** Demo clock: the instant the live cohort was current. Anchors continuity so
 *  the offline snapshot's states stay stable and honest regardless of wall time. */
export const DEMO_NOW = CAPTURED_AT;

const BIRD = "european-migratory-bird";

const TAXA: Record<string, Taxon> = {
  "Ciconia ciconia": { genus: "Ciconia", species: "ciconia", commonName: "White Stork" },
  "Streptopelia turtur": { genus: "Streptopelia", species: "turtur", commonName: "European Turtle Dove" },
  "Pernis apivorus": { genus: "Pernis", species: "apivorus", commonName: "European Honey Buzzard" },
  "Milvus milvus": { genus: "Milvus", species: "milvus", commonName: "Red Kite" },
};

function studyPageUrl(id: string): string {
  return `https://www.movebank.org/cms/webapp?gwt_fragment=page=studies,path=study${id}`;
}

/**
 * Provenance CONFIRMED 2026-06-28 by the account holder via the authenticated
 * Movebank `direct-read` service (read-only). Each study's owner-set license_type,
 * principal_investigator_name and citation were read directly from Movebank, so
 * every entry below is `verified: true`. Licenses differ per study and are
 * surfaced verbatim — the Red Kite is CC BY-NC (non-commercial use only) and the
 * CC BY studies require attribution.
 */
const CONFIRMED_PROVENANCE: Record<string, Partial<Provenance>> = {
  "21231406": {
    principalInvestigator: "Martin Wikelski (Max Planck Institute of Animal Behavior)",
    license: "CC BY 4.0",
    citation:
      "Fiedler W, Flack A, Schäfle W, Keeves B, Quetting M, Eid B, Schmid H, Wikelski M. 2024. Data from: Study 'LifeTrack White Stork SW Germany' (2013-2023). Movebank Data Repository. https://doi.org/10.5441/001/1.ck04mn78_2",
    doi: "10.5441/001/1.ck04mn78_2",
    verified: true,
  },
  "1562253659": {
    principalInvestigator: "Wolfgang Fiedler (Max Planck Institute of Animal Behavior)",
    license: "CC0 1.0",
    citation:
      "Data from study 'LifeTrack White Stork Sarralbe' on www.movebank.org — Max Planck Institute of Animal Behavior (Radolfzell, Germany) and Commune de Sarralbe.",
    verified: true,
  },
  "3413045568": {
    principalInvestigator: "Frédéric Jiguet (HABITRACK project)",
    license: "CC BY 4.0",
    citation:
      "HABITRACK: Habitat tracking for the conservation of huntable bird species (EU HORIZON, HORIZON-CL6-2023-BIODIV-01). Movebank study 'Habitrack European Turtle Dove'.",
    verified: true,
  },
  "186178781": {
    principalInvestigator: "Daniel Schmidt-Rothmund (NABU Vogelschutzzentrum Mössingen)",
    license: "CC BY 4.0",
    citation:
      "Schmidt-Rothmund D, NABU Vogelschutzzentrum Mössingen. Movebank study 'Raptors NABU Moessingen public'.",
    verified: true,
  },
  "3883692006": {
    principalInvestigator: "Wolfgang Fiedler (Max Planck Institute of Animal Behavior — ICARUS/ELSA)",
    license: "CC BY 4.0",
    citation:
      "Data from study 'MPIAB ELSA 2.0 White Stork (tagged 2024-2025)' on www.movebank.org — Max Planck Institute of Animal Behavior.",
    verified: true,
  },
  "672882373": {
    principalInvestigator: "Patrick Scherler",
    license: "CC BY-NC 4.0 (non-commercial)",
    citation: "Scherler P. Movebank study 'Milvus_milvus_atlantismarcuard' (Red Kite, Switzerland).",
    verified: true,
  },
};

/** Provenance for a real, fully-public study — CONFIRMED against authenticated
 *  Movebank direct-read (see CONFIRMED_PROVENANCE). The base fields below are a
 *  fallback for any study not yet confirmed (none, currently). */
function realProvenance(studyId: string, studyName: string): Provenance {
  return {
    studyId,
    studyName,
    principalInvestigator: "see Movebank study page",
    license: "Fully public — Movebank license terms suspended",
    licenseTermsUrl: studyPageUrl(studyId),
    citation: `Movebank study ${studyId}.`,
    verified: false,
    ...CONFIRMED_PROVENANCE[studyId],
  };
}

const STUDY_NAMES: Record<string, string> = {
  "21231406": "LifeTrack White Stork SW Germany",
  "1562253659": "LifeTrack White Stork Sarralbe [ID_PROG 1093]",
  "3413045568": "Habitrack European Turtle Dove",
  "186178781": "Raptors NABU Mössingen public",
  "3883692006": "MPIAB ELSA 2.0 White Stork (tagged 2024-2025)",
  "672882373": "Milvus milvus atlantis (Marcuard)",
};

/** The synthetic study backing the PERMISSION_LOST demonstrator only. */
const SYNTHETIC_STUDY_ID = "demo-access-controlled";

export const SEED_STUDIES: Study[] = [
  ...Object.entries(STUDY_NAMES).map(([id, name]): Study => ({
    id,
    name,
    isPublic: true,
    studyType: "telemetry",
    provenance: realProvenance(id, name),
  })),
  {
    id: SYNTHETIC_STUDY_ID,
    name: "Access-controlled regional study (demo — access revoked at runtime)",
    isPublic: true,
    studyType: "telemetry",
    provenance: {
      studyId: SYNTHETIC_STUDY_ID,
      studyName: "Access-controlled regional study (demo)",
      principalInvestigator: "n/a (synthetic demonstrator)",
      license: "n/a — synthetic demonstrator",
      verified: false,
    },
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

/** Real fixes for a captured individual, tagged with our internal id. */
function realFixes(internalId: string, trackKey: string): Fix[] {
  const t = REAL_TRACKS[trackKey];
  if (!t) throw new Error(`missing real track for ${trackKey}`);
  return t.fixes.map(([timestamp, lat, lon]): Fix => ({
    individualId: internalId,
    timestamp,
    lat,
    lon,
    sensorType: "gps",
  }));
}

interface RealSpec {
  id: string;
  trackKey: string;
  /** Display name. */
  name: string;
  /** True when we assigned the name (no personal name in the study record). */
  nameIsAssigned: boolean;
  note: string;
}

function realAnimal(spec: RealSpec, ownerResolution?: OwnerResolution): SeedAnimal {
  const t = REAL_TRACKS[spec.trackKey]!;
  const taxon = TAXA[t.taxonCanonical] ?? {
    genus: t.taxonCanonical.split(" ")[0] ?? "unknown",
    species: t.taxonCanonical.split(" ")[1] ?? "sp.",
    commonName: t.taxonCanonical,
  };
  const individual: Individual = {
    id: spec.id,
    studyId: t.studyId,
    localIdentifier: t.localIdentifier,
    taxon,
    name: spec.name,
    nameIsAssigned: spec.nameIsAssigned,
    sex: "unknown", // not fabricated; confirm from reference data when verifying
    referenceNotes: spec.note,
    expectedFixesPerWeek: 7,
  };
  const animal: SeedAnimal = { theme: BIRD, individual, fixes: realFixes(spec.id, spec.trackKey) };
  if (ownerResolution) animal.ownerResolution = ownerResolution;
  return animal;
}

const SNAPSHOT = "Real Movebank track, captured 2026-06-26 and downsampled for the offline build; live ingestion reads full resolution.";

/** Build the full seed. `now` only affects the synthetic demonstrator's recency;
 *  the real tracks carry their own absolute timestamps. */
export function buildSeed(now: number): SeedData {
  const kite = realFixes("kite-337", "kite-337");
  const kiteLastAt = kite[kite.length - 1]!.timestamp;

  const animals: SeedAnimal[] = [
    // LIVE — White Stork back on the Upper Rhine after wintering in Catalonia.
    realAnimal({
      id: "stork-louis",
      trackKey: "stork-louis",
      name: "Louis",
      nameIsAssigned: false,
      note: `Real White Stork (Movebank DER AU050), LifeTrack SW Germany. ${SNAPSHOT}`,
    }),
    // LIVE — White Stork breeding at Sarralbe, NE France; winters in Iberia.
    realAnimal({
      id: "stork-noe",
      trackKey: "stork-noe",
      name: "Noé",
      nameIsAssigned: false,
      note: `Real White Stork (Movebank CK16336), LifeTrack Sarralbe. ${SNAPSHOT}`,
    }),
    // LIVE — Turtle Dove tagged on Menorca, now in the Rhône valley (nearest Geneva).
    realAnimal({
      id: "dove-mistral",
      trackKey: "dove-menorca1",
      name: "Mistral",
      nameIsAssigned: true,
      note: `Real European Turtle Dove (Movebank "SP_Menorca 2025_1"); no personal name in the record, so we assigned one. ${SNAPSHOT}`,
    }),
    // LIVE — Honey Buzzard: long-distance Afro-Palearctic migrant from SW Germany.
    realAnimal({
      id: "buzzard-pilgrim",
      trackKey: "buzzard-honey",
      name: "Pilgrim",
      nameIsAssigned: true,
      note: `Real European Honey Buzzard (Movebank "Honey Buzzard 12212 / DER KT2169"); name assigned by us. ${SNAPSHOT}`,
    }),
    // QUIET — White Stork genuinely silent ~14 days mid-route; resting, not alarm.
    realAnimal({
      id: "stork-rosel",
      trackKey: "stork-rosel",
      name: "Rosel",
      nameIsAssigned: false,
      note: `Real White Stork (Movebank AFV89), MPIAB ELSA 2.0. Tag last reported ~14 days before capture. ${SNAPSHOT}`,
    }),
    // RESOLVED_UNKNOWN — White Stork whose tag fell silent 64 days ago; honest closure.
    realAnimal({
      id: "stork-europa",
      trackKey: "stork-europa",
      name: "Europa",
      nameIsAssigned: false,
      note: `Real White Stork (Movebank DER A1A26), LifeTrack SW Germany. Signal stopped ~64 days before capture; cause unknown. ${SNAPSHOT}`,
    }),
    // RESOLVED_KNOWN — Swiss Red Kite whose study deployment ended in 2022.
    realAnimal(
      {
        id: "kite-aare",
        trackKey: "kite-337",
        name: "Aare",
        nameIsAssigned: true,
        note: `Real Red Kite (Movebank individual "337", Milvus milvus atlantis), resident on the Swiss plateau near Bern; name assigned by us. ${SNAPSHOT}`,
      },
      {
        kind: "study-ended",
        at: kiteLastAt,
        note: "This Movebank study's public track for this bird ends in September 2022; the deployment is over.",
      },
    ),

    // PERMISSION_LOST — the one SYNTHETIC entry. A public study cannot revoke your
    // access, so this mechanism (denial ≠ death, §2.3) cannot be sourced from real
    // public data. Clearly labelled synthetic; its recent track would read LIVE if
    // access were not revoked — that is exactly the point.
    {
      theme: BIRD,
      permissionLost: true,
      individual: {
        id: "demo-permission-lost",
        studyId: SYNTHETIC_STUDY_ID,
        localIdentifier: "DEMO-PL-01",
        taxon: TAXA["Ciconia ciconia"]!,
        name: "Pip",
        nameIsAssigned: true,
        sex: "unknown",
        synthetic: true,
        referenceNotes:
          "SYNTHETIC demonstrator (not a real animal). Exercises the permission-lost → retire-silently path: a tag still transmitting but whose data owner revoked API access. Cannot be sourced from a public study by definition.",
        expectedFixesPerWeek: 7,
      },
      fixes: buildTrack({
        individualId: "demo-permission-lost",
        waypoints: [
          { lat: 47.66, lon: 9.18 },
          { lat: 46.95, lon: 7.45 },
          { lat: 44.5, lon: 4.8 },
        ],
        endAt: now - 6 * HOUR,
        cadenceHours: 24,
        count: 20,
      }),
    },
  ];

  return { studies: SEED_STUDIES, animals };
}
