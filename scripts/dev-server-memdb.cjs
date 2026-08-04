/* eslint-disable no-console */
// Server di sviluppo con database IN MEMORIA (pg-mem).
//
// Esiste perché in locale non c'è Postgres (né docker, né psql): questo consente di
// esercitare l'intero stack HTTP — routing, validazione, auth, serializzazione —
// con curl, senza deployare. NON sostituisce la verifica sull'env di branch: pg-mem
// non è Postgres (NUMERIC float-backed, nessuna funzione finestra, ecc.).
//
// Uso: node scripts/dev-server-memdb.cjs [porta]
process.env.PGHOST = process.env.PGHOST || "memdb";
process.env.APP_PASSWORD = process.env.APP_PASSWORD || "dev";
process.env.SESSION_SECRET =
  process.env.SESSION_SECRET || "0123456789abcdef0123456789abcdef0123456789";
process.env.SCHEDULER_ENABLED = "false";
process.env.PORT = process.argv[2] || process.env.PORT || "3099";

const { newDb } = require("pg-mem");
const pool = require("../src/db/pool");
const { migrate } = require("../src/db/migrate");

const db = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
for (const name of ["pg_advisory_lock", "pg_try_advisory_lock", "pg_advisory_unlock"]) {
  db.public.registerFunction({
    name,
    args: [db.public.getType("int")],
    returns: db.public.getType(name === "pg_advisory_lock" ? "text" : "bool"),
    implementation: () => (name === "pg_advisory_lock" ? "" : true),
  });
}
const { Pool } = db.adapters.createPg();
const memPool = new Pool();
pool._setPool(memPool);

const logger = require("../src/logger");
const { buildApp } = require("../src/app");
const boot = require("../src/boot");

(async () => {
  await migrate(memPool);
  boot.state.ready = true;
  boot.state.db.connected = true;
  boot.state.migrations.pending = [];
  boot.state.migrations.applied = ["001_init", "002_seed"];

  const app = buildApp();
  app.listen(Number(process.env.PORT), () =>
    logger.info(`[dev-memdb] in ascolto su :${process.env.PORT} (database in memoria)`)
  );
})().catch((e) => {
  console.error("avvio fallito:", e);
  process.exit(1);
});
