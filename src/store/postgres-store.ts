/**
 * Postgres implementation of {@link AsyncRepository}, behind a driver-agnostic
 * {@link SqlClient} so this file has NO hard dependency on `pg` (keeps the
 * runtime zero-dep). A thin `pg` Pool satisfies SqlClient:
 *
 *   import { Pool } from "pg";
 *   const pool = new Pool({ connectionString: process.env.DATABASE_URL });
 *   const repo = new PostgresRepository(pool);
 *   await repo.init();
 *
 * Timestamps are stored as `double precision` (epoch ms; exact in this range) so
 * the driver returns plain numbers rather than bigint strings. This adapter is
 * type-checked and unit-tested against a fake client; wire a real Pool + run the
 * DDL to use it against a live database.
 */

import type {
  ContinuityStatus,
  Fix,
  Individual,
  OwnerResolution,
  Study,
} from "../domain/types.ts";
import type { EventRecord, NarrativeRecord } from "./repository.ts";
import type { AsyncRepository } from "./async-repository.ts";

export interface SqlClient {
  query<T = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
  end?(): Promise<void>;
}

const DDL = `
CREATE TABLE IF NOT EXISTS studies (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, is_public BOOLEAN NOT NULL,
  study_type TEXT, provenance JSONB NOT NULL);
CREATE TABLE IF NOT EXISTS individuals (
  id TEXT PRIMARY KEY, study_id TEXT NOT NULL, local_identifier TEXT NOT NULL,
  taxon JSONB NOT NULL, name TEXT NOT NULL, name_is_assigned BOOLEAN NOT NULL,
  sex TEXT, image_url TEXT, image_is_representative BOOLEAN, reference_notes TEXT,
  expected_fixes_per_week DOUBLE PRECISION NOT NULL);
CREATE TABLE IF NOT EXISTS fixes (
  individual_id TEXT NOT NULL, ts DOUBLE PRECISION NOT NULL,
  lat DOUBLE PRECISION NOT NULL, lon DOUBLE PRECISION NOT NULL,
  sensor_type TEXT NOT NULL, quality DOUBLE PRECISION,
  PRIMARY KEY (individual_id, ts));
CREATE TABLE IF NOT EXISTS status (
  individual_id TEXT PRIMARY KEY, state TEXT NOT NULL,
  entered_at DOUBLE PRECISION NOT NULL, rationale TEXT NOT NULL,
  observed JSONB NOT NULL, directives JSONB NOT NULL, updated_at DOUBLE PRECISION NOT NULL);
CREATE TABLE IF NOT EXISTS resolutions (individual_id TEXT PRIMARY KEY, data JSONB NOT NULL);
CREATE TABLE IF NOT EXISTS narratives (
  cache_key TEXT PRIMARY KEY, individual_id TEXT NOT NULL, kind TEXT NOT NULL,
  text TEXT NOT NULL, grounding JSONB NOT NULL, created_at DOUBLE PRECISION NOT NULL);
CREATE TABLE IF NOT EXISTS events (
  id BIGSERIAL PRIMARY KEY, session_id TEXT NOT NULL, individual_id TEXT NOT NULL,
  arm TEXT NOT NULL, type TEXT NOT NULL, ts DOUBLE PRECISION NOT NULL, meta JSONB);
CREATE TABLE IF NOT EXISTS license_acceptances (
  study_id TEXT NOT NULL, terms_md5 TEXT NOT NULL, accepted_at DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (study_id, terms_md5));
`;

export class PostgresRepository implements AsyncRepository {
  private readonly db: SqlClient;
  constructor(client: SqlClient) {
    this.db = client;
  }

  /** Create tables if absent. Run once at startup (or via a migration tool). */
  async init(): Promise<void> {
    await this.db.query(DDL);
  }

  async upsertStudy(s: Study): Promise<void> {
    await this.db.query(
      `INSERT INTO studies (id, name, is_public, study_type, provenance)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, is_public=EXCLUDED.is_public,
         study_type=EXCLUDED.study_type, provenance=EXCLUDED.provenance`,
      [s.id, s.name, s.isPublic, s.studyType ?? null, JSON.stringify(s.provenance)],
    );
  }
  async getStudy(id: string): Promise<Study | null> {
    const { rows } = await this.db.query(`SELECT * FROM studies WHERE id=$1`, [id]);
    return rows[0] ? rowToStudy(rows[0]) : null;
  }
  async listStudies(): Promise<Study[]> {
    const { rows } = await this.db.query(`SELECT * FROM studies`);
    return rows.map(rowToStudy);
  }

  async upsertIndividual(i: Individual): Promise<void> {
    await this.db.query(
      `INSERT INTO individuals (id, study_id, local_identifier, taxon, name,
         name_is_assigned, sex, image_url, image_is_representative, reference_notes,
         expected_fixes_per_week)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (id) DO UPDATE SET study_id=EXCLUDED.study_id,
         local_identifier=EXCLUDED.local_identifier, taxon=EXCLUDED.taxon, name=EXCLUDED.name,
         name_is_assigned=EXCLUDED.name_is_assigned, sex=EXCLUDED.sex, image_url=EXCLUDED.image_url,
         image_is_representative=EXCLUDED.image_is_representative,
         reference_notes=EXCLUDED.reference_notes,
         expected_fixes_per_week=EXCLUDED.expected_fixes_per_week`,
      [
        i.id, i.studyId, i.localIdentifier, JSON.stringify(i.taxon), i.name,
        i.nameIsAssigned, i.sex ?? null, i.imageUrl ?? null,
        i.imageIsRepresentative ?? null, i.referenceNotes ?? null, i.expectedFixesPerWeek,
      ],
    );
  }
  async getIndividual(id: string): Promise<Individual | null> {
    const { rows } = await this.db.query(`SELECT * FROM individuals WHERE id=$1`, [id]);
    return rows[0] ? rowToIndividual(rows[0]) : null;
  }
  async listIndividuals(): Promise<Individual[]> {
    const { rows } = await this.db.query(`SELECT * FROM individuals`);
    return rows.map(rowToIndividual);
  }

  async upsertFixes(fixes: Fix[]): Promise<number> {
    let added = 0;
    for (const f of fixes) {
      const { rows } = await this.db.query<{ inserted: boolean }>(
        `INSERT INTO fixes (individual_id, ts, lat, lon, sensor_type, quality)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (individual_id, ts) DO NOTHING
         RETURNING true AS inserted`,
        [f.individualId, f.timestamp, f.lat, f.lon, f.sensorType, f.quality ?? null],
      );
      if (rows[0]?.inserted) added++;
    }
    return added;
  }
  async getFixes(individualId: string, sinceMs?: number): Promise<Fix[]> {
    const { rows } =
      sinceMs === undefined
        ? await this.db.query(`SELECT * FROM fixes WHERE individual_id=$1 ORDER BY ts ASC`, [individualId])
        : await this.db.query(
            `SELECT * FROM fixes WHERE individual_id=$1 AND ts>=$2 ORDER BY ts ASC`,
            [individualId, sinceMs],
          );
    return rows.map(rowToFix);
  }

  async saveStatus(s: ContinuityStatus): Promise<void> {
    await this.db.query(
      `INSERT INTO status (individual_id, state, entered_at, rationale, observed, directives, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (individual_id) DO UPDATE SET state=EXCLUDED.state, entered_at=EXCLUDED.entered_at,
         rationale=EXCLUDED.rationale, observed=EXCLUDED.observed, directives=EXCLUDED.directives,
         updated_at=EXCLUDED.updated_at`,
      [
        s.individualId, s.state, s.enteredAt, s.rationale,
        JSON.stringify(s.observed), JSON.stringify(s.directives), Date.now(),
      ],
    );
  }
  async getStatus(individualId: string): Promise<ContinuityStatus | null> {
    const { rows } = await this.db.query(`SELECT * FROM status WHERE individual_id=$1`, [individualId]);
    return rows[0] ? rowToStatus(rows[0]) : null;
  }
  async listStatuses(): Promise<ContinuityStatus[]> {
    const { rows } = await this.db.query(`SELECT * FROM status`);
    return rows.map(rowToStatus);
  }

  async setResolution(individualId: string, r: OwnerResolution | null): Promise<void> {
    if (r === null) {
      await this.db.query(`DELETE FROM resolutions WHERE individual_id=$1`, [individualId]);
      return;
    }
    await this.db.query(
      `INSERT INTO resolutions (individual_id, data) VALUES ($1,$2)
       ON CONFLICT (individual_id) DO UPDATE SET data=EXCLUDED.data`,
      [individualId, JSON.stringify(r)],
    );
  }
  async getResolution(individualId: string): Promise<OwnerResolution | null> {
    const { rows } = await this.db.query<{ data: OwnerResolution }>(
      `SELECT data FROM resolutions WHERE individual_id=$1`, [individualId]);
    return rows[0] ? asJson<OwnerResolution>(rows[0].data) : null;
  }

  async saveNarrative(n: NarrativeRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO narratives (cache_key, individual_id, kind, text, grounding, created_at)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (cache_key) DO NOTHING`,
      [n.cacheKey, n.individualId, n.kind, n.text, n.groundingJson, n.createdAt],
    );
  }
  async getNarrative(cacheKey: string): Promise<NarrativeRecord | null> {
    const { rows } = await this.db.query(`SELECT * FROM narratives WHERE cache_key=$1`, [cacheKey]);
    const r = rows[0];
    if (!r) return null;
    return {
      cacheKey: r.cache_key as string,
      individualId: r.individual_id as string,
      kind: r.kind as NarrativeRecord["kind"],
      text: r.text as string,
      groundingJson: typeof r.grounding === "string" ? r.grounding : JSON.stringify(r.grounding),
      createdAt: Number(r.created_at),
    };
  }

  async recordEvent(e: EventRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO events (session_id, individual_id, arm, type, ts, meta)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [e.sessionId, e.individualId, e.arm, e.type, e.ts, e.meta ? JSON.stringify(e.meta) : null],
    );
  }
  async allEvents(): Promise<EventRecord[]> {
    const { rows } = await this.db.query(`SELECT * FROM events ORDER BY ts ASC`);
    return rows.map((r) => {
      const ev: EventRecord = {
        sessionId: r.session_id as string,
        individualId: r.individual_id as string,
        arm: r.arm as EventRecord["arm"],
        type: r.type as EventRecord["type"],
        ts: Number(r.ts),
      };
      if (r.meta != null) ev.meta = asJson<Record<string, unknown>>(r.meta);
      return ev;
    });
  }

  async recordLicenseAcceptance(studyId: string, md5: string): Promise<void> {
    await this.db.query(
      `INSERT INTO license_acceptances (study_id, terms_md5, accepted_at)
       VALUES ($1,$2,$3) ON CONFLICT (study_id, terms_md5) DO NOTHING`,
      [studyId, md5, Date.now()],
    );
  }
  async hasAcceptedLicense(studyId: string): Promise<boolean> {
    const { rows } = await this.db.query(
      `SELECT 1 FROM license_acceptances WHERE study_id=$1 LIMIT 1`, [studyId]);
    return rows.length > 0;
  }

  async resetAll(): Promise<void> {
    await this.db.query(
      `TRUNCATE studies, individuals, fixes, status, resolutions, narratives, events, license_acceptances`,
    );
  }
  async close(): Promise<void> {
    await this.db.end?.();
  }
}

// -- row mappers (jsonb columns arrive parsed; booleans are real booleans) ----

function asJson<T>(v: unknown): T {
  return (typeof v === "string" ? JSON.parse(v) : v) as T;
}

function rowToStudy(r: Record<string, unknown>): Study {
  const s: Study = {
    id: r.id as string,
    name: r.name as string,
    isPublic: Boolean(r.is_public),
    provenance: asJson(r.provenance),
  };
  if (r.study_type != null) s.studyType = r.study_type as string;
  return s;
}
function rowToIndividual(r: Record<string, unknown>): Individual {
  const i: Individual = {
    id: r.id as string,
    studyId: r.study_id as string,
    localIdentifier: r.local_identifier as string,
    taxon: asJson(r.taxon),
    name: r.name as string,
    nameIsAssigned: Boolean(r.name_is_assigned),
    expectedFixesPerWeek: Number(r.expected_fixes_per_week),
  };
  if (r.sex != null) i.sex = r.sex as Individual["sex"];
  if (r.image_url != null) i.imageUrl = r.image_url as string;
  if (r.image_is_representative != null) i.imageIsRepresentative = Boolean(r.image_is_representative);
  if (r.reference_notes != null) i.referenceNotes = r.reference_notes as string;
  return i;
}
function rowToFix(r: Record<string, unknown>): Fix {
  const f: Fix = {
    individualId: r.individual_id as string,
    timestamp: Number(r.ts),
    lat: Number(r.lat),
    lon: Number(r.lon),
    sensorType: r.sensor_type as Fix["sensorType"],
  };
  if (r.quality != null) f.quality = Number(r.quality);
  return f;
}
function rowToStatus(r: Record<string, unknown>): ContinuityStatus {
  return {
    individualId: r.individual_id as string,
    state: r.state as ContinuityStatus["state"],
    enteredAt: Number(r.entered_at),
    rationale: r.rationale as string,
    observed: asJson(r.observed),
    directives: asJson(r.directives),
  };
}
