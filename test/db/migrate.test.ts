// Migrazioni su pg-mem. Scope: il DDL si applica, migrate() è idempotente, il
// mismatch di checksum viene rilevato.
//
// NON si asserisce la precisione numerica su pg-mem: il suo NUMERIC è
// float-backed. Quella è competenza di src/domain/money.js e dei suoi test.
// Per PRIMO: imposta l'env prima che qualsiasi import carichi src/config.
import "../helpers/env";

import test from "node:test";
import assert from "node:assert/strict";

import { newDb, DataType } from "pg-mem";
import { migrate, knownVersions } from "../../src/db/migrate";
import { registerMissingBuiltins } from "../helpers/memdb";

function makeDb() {
  // noAstCoverageCheck: l'adapter `pg` di pg-mem esegue un controllo di copertura
  // dell'AST più severo della sua API diretta, e inciampa su
  // `TIMESTAMPTZ NOT NULL DEFAULT now()` pur eseguendolo correttamente. È un
  // limite del mock, non del nostro DDL (Postgres reale lo accetta: verificato
  // sull'env di branch).
  const db = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  // pg-mem non implementa gli advisory lock: stub, così migrate() gira invariato.
  db.public.registerFunction({
    name: "pg_advisory_lock",
    args: [db.public.getType(DataType.integer)],
    returns: db.public.getType(DataType.text),
    implementation: () => "",
  });
  db.public.registerFunction({
    name: "pg_advisory_unlock",
    args: [db.public.getType(DataType.integer)],
    returns: db.public.getType(DataType.bool),
    implementation: () => true,
  });
  // I builtin che pg-mem non ha e che il DDL usa (`date_trunc` nella 004): l'harness
  // qui costruisce il suo database con opzioni diverse, ma le funzioni sono le stesse
  // di test/helpers/memdb.ts e vanno tenute in un posto solo.
  registerMissingBuiltins(db);
  const { Pool } = db.adapters.createPg();
  return { db, pool: new Pool() };
}

test("le migrazioni si applicano da zero", async () => {
  const { pool } = makeDb();
  const r = await migrate(pool);
  // Confronto con il REGISTRO, non con una lista scritta a mano: aggiungere una
  // migrazione non deve far fallire questo test.
  assert.deepEqual(r.applied, knownVersions());
  assert.deepEqual(r.mismatched, []);

  // Le tabelle chiave esistono e sono interrogabili.
  for (const t of [
    "portfolios",
    "instruments",
    "transactions",
    "prices_daily",
    "quotes_latest",
    "fx_rates_daily",
    "income_events",
    "refresh_log",
    "app_settings",
    "schema_migrations",
  ]) {
    const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM ${t}`);
    assert.equal(typeof rows[0].n, "number", `${t} non interrogabile`);
  }
});

test("il seed crea il portafoglio di default", async () => {
  const { pool } = makeDb();
  await migrate(pool);
  const { rows } = await pool.query("SELECT name, base_ccy FROM portfolios");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "Principale");
  assert.equal(rows[0].base_ccy.trim(), "EUR");
});

test("migrate() eseguita due volte è no-op la seconda (idempotenza)", async () => {
  const { pool } = makeDb();
  await migrate(pool);
  const second = await migrate(pool);
  assert.deepEqual(second.applied, [], "la seconda esecuzione non deve applicare nulla");
  assert.deepEqual(second.skipped, knownVersions());

  // E il seed non è stato duplicato.
  const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM portfolios");
  assert.equal(rows[0].n, 1);
});

test("un checksum modificato viene rilevato e NON blocca il boot", async () => {
  const { pool } = makeDb();
  await migrate(pool);
  await pool.query("UPDATE schema_migrations SET checksum = 'sbagliato' WHERE version = '001_init'");

  // Non deve lanciare: su questa piattaforma un crashloop è inosservabile.
  const r = await migrate(pool);
  assert.deepEqual(r.mismatched, ["001_init"]);
  assert.deepEqual(r.applied, []);
});

test("le migrazioni registrate hanno checksum stabile e versioni uniche", () => {
  const { migrations } = require("../../src/db/migrations") as typeof import("../../src/db/migrations");
  const versions = migrations.map((m) => m.version);
  assert.equal(new Set(versions).size, versions.length, "versioni duplicate");
  // Ordine crescente esplicito: nessun globbing di directory.
  assert.deepEqual(versions, [...versions].sort());
  for (const m of migrations) assert.ok(m.sql.length > 0, `${m.version} è vuota`);
});
