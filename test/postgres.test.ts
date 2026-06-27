import { test } from "node:test";
import assert from "node:assert/strict";
import { PostgresRepository, type SqlClient } from "../src/store/postgres-store.ts";
import { toAsync } from "../src/store/async-repository.ts";
import { SqliteRepository } from "../src/store/sqlite-store.ts";
import type { Study } from "../src/domain/types.ts";

class FakeSqlClient implements SqlClient {
  calls: Array<{ text: string; params: unknown[] | undefined }> = [];
  private readonly responder: (text: string, params?: unknown[]) => unknown[];
  constructor(responder: (text: string, params?: unknown[]) => unknown[]) {
    this.responder = responder;
  }
  async query<T = Record<string, unknown>>(text: string, params?: unknown[]) {
    this.calls.push({ text, params });
    return { rows: (this.responder(text, params) ?? []) as T[] };
  }
}

const study: Study = {
  id: "S1",
  name: "Demo",
  isPublic: true,
  studyType: "telemetry",
  provenance: { studyId: "S1", studyName: "Demo", license: "CC0", verified: true },
};

test("PostgresRepository.upsertStudy sends a boolean is_public and jsonb provenance", async () => {
  const fake = new FakeSqlClient(() => []);
  const repo = new PostgresRepository(fake);
  await repo.upsertStudy(study);
  const call = fake.calls.at(-1)!;
  assert.match(call.text, /INSERT INTO studies/);
  assert.equal(call.params![2], true, "is_public passed as a real boolean");
  assert.equal(typeof call.params![4], "string", "provenance serialized to json");
});

test("PostgresRepository.getStudy maps a jsonb/boolean row back to the domain", async () => {
  const fake = new FakeSqlClient((text) =>
    /SELECT \* FROM studies/.test(text)
      ? [{
          id: "S1", name: "Demo", is_public: true, study_type: "telemetry",
          provenance: { studyId: "S1", studyName: "Demo", license: "CC0", verified: true }, // jsonb → object
        }]
      : [],
  );
  const repo = new PostgresRepository(fake);
  const got = await repo.getStudy("S1");
  assert.deepEqual(got, study, "round-trips through Postgres-shaped rows");
});

test("PostgresRepository.upsertFixes counts only the RETURNING-inserted rows", async () => {
  let n = 0;
  const fake = new FakeSqlClient((text) => {
    if (/INSERT INTO fixes/.test(text)) {
      n++;
      return n === 1 ? [{ inserted: true }] : []; // 2nd conflicts → no RETURNING row
    }
    return [];
  });
  const repo = new PostgresRepository(fake);
  const added = await repo.upsertFixes([
    { individualId: "I1", timestamp: 1, lat: 1, lon: 1, sensorType: "gps" },
    { individualId: "I1", timestamp: 1, lat: 1, lon: 1, sensorType: "gps" },
  ]);
  assert.equal(added, 1);
});

test("resetAll issues a single TRUNCATE across all tables", async () => {
  const fake = new FakeSqlClient(() => []);
  await new PostgresRepository(fake).resetAll();
  assert.match(fake.calls.at(-1)!.text, /TRUNCATE studies, individuals, fixes/);
});

test("toAsync makes the sqlite store satisfy the AsyncRepository seam", async () => {
  const repo = toAsync(SqliteRepository.open(":memory:"));
  await repo.upsertStudy(study);
  assert.deepEqual(await repo.getStudy("S1"), study);
  await repo.upsertFixes([{ individualId: "I1", timestamp: 5, lat: 1, lon: 2, sensorType: "gps" }]);
  assert.equal((await repo.getFixes("I1")).length, 1);
  await repo.close();
});
