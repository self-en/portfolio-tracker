// Harness pg-mem condiviso dai test di repo e degli endpoint calcolati.
//
// pg-mem parla Postgres ma non è Postgres. Ogni scostamento gestito qui è
// documentato: sono limiti del MOCK, non adattamenti dello schema di produzione.
//
// Cosa questi test NON possono dimostrare (va verificato sull'env di branch):
//   - precisione NUMERIC: il NUMERIC di pg-mem è float-backed
//   - i type parser di `pg`: pg-mem non passa dal protocollo wire
//     (verificati direttamente in test/db/typeParsers.test.ts)
//   - funzioni finestra (`OVER`), advisory lock reali, indici unique parziali
import { newDb, DataType } from "pg-mem";
import type { IMemoryDb } from "pg-mem";
import * as pool from "../../src/db/pool";
import { migrate } from "../../src/db/migrate";
import type { TestContext } from "node:test";

function makeDb() {
  const db = newDb({
    // AST coverage: l'adapter `pg` di pg-mem esegue un controllo più severo della
    // sua API diretta e inciampa su `TIMESTAMPTZ NOT NULL DEFAULT now()` pur
    // eseguendolo correttamente.
    noAstCoverageCheck: true,
    // autoCreateForeignKeyIndices NON va attivato: con gli indici FK automatici,
    // `colonna = ANY($1::int[])` restituisce ZERO righe su una colonna indicizzata
    // (verificato in isolamento). È un bug di pg-mem nel percorso di scansione
    // indicizzata di ANY, e ci costerebbe silenziosamente ogni test che carica più
    // strumenti in una query.
    autoCreateForeignKeyIndices: false,
  });

  // Gli advisory lock non esistono in pg-mem: si stubbano così migrate() e
  // db/leader.js girano invariati.
  for (const name of ["pg_advisory_lock", "pg_try_advisory_lock", "pg_advisory_unlock"]) {
    db.public.registerFunction({
      name,
      args: [db.public.getType(DataType.integer)],
      returns: db.public.getType(name === "pg_advisory_lock" ? DataType.text : DataType.bool),
      implementation: () => (name === "pg_advisory_lock" ? "" : true),
    });
  }

  registerMissingBuiltins(db);

  return db;
}

/**
 * I builtin di Postgres che pg-mem non implementa e che il nostro SQL usa.
 *
 * Sta in una funzione esportata perché serve a DUE harness: questo e quello di
 * `test/db/migrate.test.ts`, che costruisce il suo database con opzioni diverse. Due
 * copie della stessa implementazione si scollerebbero al primo builtin aggiunto.
 */
function registerMissingBuiltins(db: IMemoryDb): void {
  // `to_char(date, text)`: si registra la funzione vera invece di piegare l'SQL di
  // produzione a un builtin mancante. Qui serve solo il formato 'YYYY-MM' del
  // raggruppamento per mese.
  db.public.registerFunction({
    name: "to_char",
    args: [db.public.getType(DataType.date), db.public.getType(DataType.text)],
    returns: db.public.getType(DataType.text),
    implementation: (date: Date | string | null, format: string) => {
      if (date === null || date === undefined) return null;
      const iso = date instanceof Date ? date.toISOString().slice(0, 10) : String(date).slice(0, 10);
      if (format === "YYYY-MM") return iso.slice(0, 7);
      if (format === "YYYY") return iso.slice(0, 4);
      if (format === "YYYY-MM-DD") return iso;
      return iso;
    },
  });

  // `date_trunc(text, timestamptz)`: la migrazione 004 lo usa come DEFAULT di
  // `instrument_analyses.created_at` — non per gusto: il
  // driver `pg` consegna i TIMESTAMPTZ come `Date` JS, che si ferma al millisecondo,
  // quindi un timestamp con i microsecondi non sopravvive al giro export → JSON →
  // import e la deduplicazione delle analisi fallirebbe. Si registra la funzione
  // vera invece di piegare lo schema di produzione a un builtin mancante.
  db.public.registerFunction({
    name: "date_trunc",
    args: [db.public.getType(DataType.text), db.public.getType(DataType.timestamptz)],
    returns: db.public.getType(DataType.timestamptz),
    implementation: (unit: string, at: Date | string | null) => {
      if (at === null || at === undefined) return null;
      const dt = at instanceof Date ? new Date(at.getTime()) : new Date(String(at));
      if (Number.isNaN(dt.getTime())) return null;
      // Serve solo 'milliseconds': un `Date` JS è già troncato lì, quindi la
      // funzione è l'identità — ma registrarla è ciò che fa girare la DDL reale.
      if (unit === "milliseconds") return dt;
      if (unit === "second") return new Date(Math.floor(dt.getTime() / 1000) * 1000);
      if (unit === "day") return new Date(`${dt.toISOString().slice(0, 10)}T00:00:00.000Z`);
      return dt;
    },
  });
}

/** Crea un database in memoria migrato e lo installa nel pool globale. */
async function freshMemDb() {
  const db = makeDb();
  const { Pool } = db.adapters.createPg();
  const p = new Pool();
  pool._setPool(p);
  await migrate(p);
  return { db, pool: p };
}

/**
 * Esegue `fn`, ma SALTA il test se pg-mem non supporta il costrutto, invece di
 * riportare un fallimento fuorviante.
 */
async function tolerantMem(t: TestContext, fn: () => unknown | Promise<unknown>) {
  try {
    await fn();
  } catch (err) {
    const msg = String((err as { message?: unknown })?.message || "");
    if (/not supported|NotSupported|🔨|does not exist|cannot cast/i.test(msg)) {
      t.skip(`limite di pg-mem: ${msg.split("\n")[0].slice(0, 120)}`);
      return;
    }
    throw err;
  }
}

export { makeDb, freshMemDb, tolerantMem, registerMissingBuiltins };
