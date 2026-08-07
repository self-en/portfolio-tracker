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
// `date_trunc(text, timestamptz)`: pg-mem non lo implementa e la migrazione 004 lo
// usa come DEFAULT di `instrument_analyses.created_at` (troncare al millisecondo è
// ciò che rende idempotente il reimport delle analisi — vedi docs/decisions.md §12.1).
// Senza questa registrazione il server di sviluppo non parte più. L'equivalente per i
// test sta in test/helpers/memdb.ts.
db.public.registerFunction({
  name: "date_trunc",
  args: [db.public.getType("text"), db.public.getType("timestamptz")],
  returns: db.public.getType("timestamptz"),
  implementation: (unit, at) => {
    if (at === null || at === undefined) return null;
    const dt = at instanceof Date ? new Date(at.getTime()) : new Date(String(at));
    if (Number.isNaN(dt.getTime())) return null;
    // Un `Date` JS è già al millisecondo: per 'milliseconds' la funzione è l'identità.
    if (unit === "second") return new Date(Math.floor(dt.getTime() / 1000) * 1000);
    if (unit === "day") return new Date(`${dt.toISOString().slice(0, 10)}T00:00:00.000Z`);
    return dt;
  },
});

const { Pool } = db.adapters.createPg();
const memPool = new Pool();
pool._setPool(memPool);

// I moduli di src/ sono TypeScript con export default: sotto tsx, require() di un
// export default restituisce { default: ... }. Questo script e' CJS di proposito
// (lo si lancia con `node --import tsx`), quindi l'interop la fa a mano.
const interop = (m) => (m && m.default) || m;
const logger = interop(require("../src/logger"));
const { buildApp } = require("../src/app");
const boot = require("../src/boot");

(async () => {
  await migrate(memPool);
  boot.state.ready = true;
  boot.state.db.connected = true;
  boot.state.migrations.pending = [];
  boot.state.migrations.applied = ["001_init", "002_seed"];

  // Fastify: buildApp e listen sono asincroni, e listen restituisce l'indirizzo.
  const app = await buildApp();
  const address = await app.listen({ port: Number(process.env.PORT), host: "127.0.0.1" });
  logger.info(`[dev-memdb] in ascolto su ${address} (database in memoria)`);
})().catch((e) => {
  console.error("avvio fallito:", e);
  process.exit(1);
});
