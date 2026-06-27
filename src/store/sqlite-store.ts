/**
 * SQLite-backed repository using Node's built-in node:sqlite (zero install).
 * Adequate for a hand-curated roster of 5–15 animals polled a few times a day;
 * swappable for Postgres behind the {@link Repository} interface for scale.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  ContinuityStatus,
  Fix,
  Individual,
  OwnerResolution,
  Study,
} from "../domain/types.ts";
import type { EventRecord, NarrativeRecord, Repository } from "./repository.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS studies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  is_public INTEGER NOT NULL,
  study_type TEXT,
  provenance_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS individuals (
  id TEXT PRIMARY KEY,
  study_id TEXT NOT NULL,
  local_identifier TEXT NOT NULL,
  taxon_json TEXT NOT NULL,
  name TEXT NOT NULL,
  name_is_assigned INTEGER NOT NULL,
  sex TEXT,
  image_url TEXT,
  image_is_representative INTEGER,
  reference_notes TEXT,
  expected_fixes_per_week REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS fixes (
  individual_id TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  sensor_type TEXT NOT NULL,
  quality REAL,
  PRIMARY KEY (individual_id, timestamp)
);
CREATE INDEX IF NOT EXISTS idx_fixes_ind_ts ON fixes (individual_id, timestamp);
CREATE TABLE IF NOT EXISTS status (
  individual_id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  entered_at INTEGER NOT NULL,
  rationale TEXT NOT NULL,
  observed_json TEXT NOT NULL,
  directives_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS resolutions (
  individual_id TEXT PRIMARY KEY,
  json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS narratives (
  cache_key TEXT PRIMARY KEY,
  individual_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  grounding_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  individual_id TEXT NOT NULL,
  arm TEXT NOT NULL,
  type TEXT NOT NULL,
  ts INTEGER NOT NULL,
  meta_json TEXT
);
CREATE TABLE IF NOT EXISTS license_acceptances (
  study_id TEXT NOT NULL,
  terms_md5 TEXT NOT NULL,
  accepted_at INTEGER NOT NULL,
  PRIMARY KEY (study_id, terms_md5)
);
`;

const bool = (v: boolean): number => (v ? 1 : 0);

export class SqliteRepository implements Repository {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA);
  }

  static open(path: string): SqliteRepository {
    return new SqliteRepository(path);
  }

  // -- studies ---------------------------------------------------------------

  upsertStudy(s: Study): void {
    this.db
      .prepare(
        `INSERT INTO studies (id, name, is_public, study_type, provenance_json)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name, is_public = excluded.is_public,
           study_type = excluded.study_type, provenance_json = excluded.provenance_json`,
      )
      .run(s.id, s.name, bool(s.isPublic), s.studyType ?? null, JSON.stringify(s.provenance));
  }

  getStudy(id: string): Study | null {
    const r = this.db.prepare(`SELECT * FROM studies WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return r ? rowToStudy(r) : null;
  }

  listStudies(): Study[] {
    return (this.db.prepare(`SELECT * FROM studies`).all() as Record<string, unknown>[]).map(
      rowToStudy,
    );
  }

  // -- individuals -----------------------------------------------------------

  upsertIndividual(i: Individual): void {
    this.db
      .prepare(
        `INSERT INTO individuals
           (id, study_id, local_identifier, taxon_json, name, name_is_assigned,
            sex, image_url, image_is_representative, reference_notes, expected_fixes_per_week)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           study_id = excluded.study_id, local_identifier = excluded.local_identifier,
           taxon_json = excluded.taxon_json, name = excluded.name,
           name_is_assigned = excluded.name_is_assigned, sex = excluded.sex,
           image_url = excluded.image_url, image_is_representative = excluded.image_is_representative,
           reference_notes = excluded.reference_notes,
           expected_fixes_per_week = excluded.expected_fixes_per_week`,
      )
      .run(
        i.id,
        i.studyId,
        i.localIdentifier,
        JSON.stringify(i.taxon),
        i.name,
        bool(i.nameIsAssigned),
        i.sex ?? null,
        i.imageUrl ?? null,
        i.imageIsRepresentative === undefined ? null : bool(i.imageIsRepresentative),
        i.referenceNotes ?? null,
        i.expectedFixesPerWeek,
      );
  }

  getIndividual(id: string): Individual | null {
    const r = this.db.prepare(`SELECT * FROM individuals WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return r ? rowToIndividual(r) : null;
  }

  listIndividuals(): Individual[] {
    return (
      this.db.prepare(`SELECT * FROM individuals`).all() as Record<string, unknown>[]
    ).map(rowToIndividual);
  }

  // -- fixes -----------------------------------------------------------------

  upsertFixes(fixes: Fix[]): number {
    if (fixes.length === 0) return 0;
    const stmt = this.db.prepare(
      `INSERT INTO fixes (individual_id, timestamp, lat, lon, sensor_type, quality)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(individual_id, timestamp) DO NOTHING`,
    );
    let added = 0;
    this.db.exec("BEGIN");
    try {
      for (const f of fixes) {
        const res = stmt.run(
          f.individualId,
          f.timestamp,
          f.lat,
          f.lon,
          f.sensorType,
          f.quality ?? null,
        );
        added += Number(res.changes);
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return added;
  }

  getFixes(individualId: string, sinceMs?: number): Fix[] {
    const rows = (
      sinceMs === undefined
        ? this.db
            .prepare(`SELECT * FROM fixes WHERE individual_id = ? ORDER BY timestamp ASC`)
            .all(individualId)
        : this.db
            .prepare(
              `SELECT * FROM fixes WHERE individual_id = ? AND timestamp >= ? ORDER BY timestamp ASC`,
            )
            .all(individualId, sinceMs)
    ) as Record<string, unknown>[];
    return rows.map(rowToFix);
  }

  // -- status ----------------------------------------------------------------

  saveStatus(s: ContinuityStatus): void {
    this.db
      .prepare(
        `INSERT INTO status
           (individual_id, state, entered_at, rationale, observed_json, directives_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(individual_id) DO UPDATE SET
           state = excluded.state, entered_at = excluded.entered_at,
           rationale = excluded.rationale, observed_json = excluded.observed_json,
           directives_json = excluded.directives_json, updated_at = excluded.updated_at`,
      )
      .run(
        s.individualId,
        s.state,
        s.enteredAt,
        s.rationale,
        JSON.stringify(s.observed),
        JSON.stringify(s.directives),
        Date.now(),
      );
  }

  getStatus(individualId: string): ContinuityStatus | null {
    const r = this.db
      .prepare(`SELECT * FROM status WHERE individual_id = ?`)
      .get(individualId) as Record<string, unknown> | undefined;
    return r ? rowToStatus(r) : null;
  }

  listStatuses(): ContinuityStatus[] {
    return (
      this.db.prepare(`SELECT * FROM status`).all() as Record<string, unknown>[]
    ).map(rowToStatus);
  }

  // -- resolutions -----------------------------------------------------------

  setResolution(individualId: string, r: OwnerResolution | null): void {
    if (r === null) {
      this.db.prepare(`DELETE FROM resolutions WHERE individual_id = ?`).run(individualId);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO resolutions (individual_id, json) VALUES (?, ?)
         ON CONFLICT(individual_id) DO UPDATE SET json = excluded.json`,
      )
      .run(individualId, JSON.stringify(r));
  }

  getResolution(individualId: string): OwnerResolution | null {
    const r = this.db
      .prepare(`SELECT json FROM resolutions WHERE individual_id = ?`)
      .get(individualId) as { json: string } | undefined;
    return r ? (JSON.parse(r.json) as OwnerResolution) : null;
  }

  // -- narratives ------------------------------------------------------------

  saveNarrative(n: NarrativeRecord): void {
    this.db
      .prepare(
        `INSERT INTO narratives (cache_key, individual_id, kind, text, grounding_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(cache_key) DO NOTHING`,
      )
      .run(n.cacheKey, n.individualId, n.kind, n.text, n.groundingJson, n.createdAt);
  }

  getNarrative(cacheKey: string): NarrativeRecord | null {
    const r = this.db
      .prepare(`SELECT * FROM narratives WHERE cache_key = ?`)
      .get(cacheKey) as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      cacheKey: r.cache_key as string,
      individualId: r.individual_id as string,
      kind: r.kind as NarrativeRecord["kind"],
      text: r.text as string,
      groundingJson: r.grounding_json as string,
      createdAt: r.created_at as number,
    };
  }

  // -- events ----------------------------------------------------------------

  recordEvent(e: EventRecord): void {
    this.db
      .prepare(
        `INSERT INTO events (session_id, individual_id, arm, type, ts, meta_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        e.sessionId,
        e.individualId,
        e.arm,
        e.type,
        e.ts,
        e.meta ? JSON.stringify(e.meta) : null,
      );
  }

  allEvents(): EventRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM events ORDER BY ts ASC`)
      .all() as Record<string, unknown>[];
    return rows.map((r) => ({
      sessionId: r.session_id as string,
      individualId: r.individual_id as string,
      arm: r.arm as EventRecord["arm"],
      type: r.type as EventRecord["type"],
      ts: r.ts as number,
      meta: r.meta_json ? (JSON.parse(r.meta_json as string) as Record<string, unknown>) : undefined,
    }));
  }

  // -- license audit ---------------------------------------------------------

  recordLicenseAcceptance(studyId: string, md5: string): void {
    this.db
      .prepare(
        `INSERT INTO license_acceptances (study_id, terms_md5, accepted_at)
         VALUES (?, ?, ?) ON CONFLICT(study_id, terms_md5) DO NOTHING`,
      )
      .run(studyId, md5, Date.now());
  }

  hasAcceptedLicense(studyId: string): boolean {
    const r = this.db
      .prepare(`SELECT 1 FROM license_acceptances WHERE study_id = ? LIMIT 1`)
      .get(studyId);
    return r !== undefined;
  }

  resetAll(): void {
    for (const t of [
      "studies", "individuals", "fixes", "status", "resolutions",
      "narratives", "events", "license_acceptances",
    ]) {
      this.db.exec(`DELETE FROM ${t};`);
    }
  }

  close(): void {
    this.db.close();
  }
}

// -- row mappers -------------------------------------------------------------

function rowToStudy(r: Record<string, unknown>): Study {
  const s: Study = {
    id: r.id as string,
    name: r.name as string,
    isPublic: (r.is_public as number) === 1,
    provenance: JSON.parse(r.provenance_json as string),
  };
  if (r.study_type != null) s.studyType = r.study_type as string;
  return s;
}

function rowToIndividual(r: Record<string, unknown>): Individual {
  const i: Individual = {
    id: r.id as string,
    studyId: r.study_id as string,
    localIdentifier: r.local_identifier as string,
    taxon: JSON.parse(r.taxon_json as string),
    name: r.name as string,
    nameIsAssigned: (r.name_is_assigned as number) === 1,
    expectedFixesPerWeek: r.expected_fixes_per_week as number,
  };
  if (r.sex != null) i.sex = r.sex as Individual["sex"];
  if (r.image_url != null) i.imageUrl = r.image_url as string;
  if (r.image_is_representative != null)
    i.imageIsRepresentative = (r.image_is_representative as number) === 1;
  if (r.reference_notes != null) i.referenceNotes = r.reference_notes as string;
  return i;
}

function rowToFix(r: Record<string, unknown>): Fix {
  const f: Fix = {
    individualId: r.individual_id as string,
    timestamp: r.timestamp as number,
    lat: r.lat as number,
    lon: r.lon as number,
    sensorType: r.sensor_type as Fix["sensorType"],
  };
  if (r.quality != null) f.quality = r.quality as number;
  return f;
}

function rowToStatus(r: Record<string, unknown>): ContinuityStatus {
  return {
    individualId: r.individual_id as string,
    state: r.state as ContinuityStatus["state"],
    enteredAt: r.entered_at as number,
    rationale: r.rationale as string,
    observed: JSON.parse(r.observed_json as string),
    directives: JSON.parse(r.directives_json as string),
  };
}
