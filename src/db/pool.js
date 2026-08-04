// Pool Postgres + type parser.
//
// I TYPE PARSER NON SONO NEGOZIABILI (docs/decisions.md §1). Vengono registrati
// al require di questo modulo, prima che qualsiasi query possa partire: sono
// globali al driver `pg`, non per-pool.
const { types, Pool } = require("pg");
const config = require("../config");
const logger = require("../logger");

// 1700 NUMERIC → stringa. Il default di pg è parseFloat, che butta via
// esattamente la precisione per cui abbiamo scelto NUMERIC.
types.setTypeParser(1700, (v) => v);
// 20 INT8 → stringa. Un bigint non entra in un Number in sicurezza.
types.setTypeParser(20, (v) => v);
// 1082 DATE → stringa 'YYYY-MM-DD'. Questo è quello che tutti dimenticano: il
// default costruisce un Date a MEZZANOTTE LOCALE, e un toISOString() a valle
// trasforma 2026-01-01 in 2025-12-31.
types.setTypeParser(1082, (v) => v);

let pool = null;

function getPool() {
  if (pool) return pool;
  if (!config.db.configured) return null;

  pool = new Pool(
    config.db.useDiscrete
      ? {
          // Le PG* discrete sono preferite alla URL: evitano i problemi di
          // URL-encoding nella password generata dalla piattaforma.
          max: config.db.maxClients,
          statement_timeout: config.db.statementTimeoutMs,
        }
      : {
          connectionString: config.db.connectionString,
          max: config.db.maxClients,
          statement_timeout: config.db.statementTimeoutMs,
        }
  );

  // Un errore su un client idle non deve abbattere il processo: pg emette
  // 'error' sul pool e senza listener diventa un'eccezione non gestita.
  pool.on("error", (err) => {
    logger.error({ err: err.message }, "[db] errore su client idle del pool");
  });

  return pool;
}

/** Query di comodo. Lancia se il DB non è configurato: i chiamanti passano dal gate `ready`. */
async function query(text, params) {
  const p = getPool();
  if (!p) throw new Error("database non configurato");
  return p.query(text, params);
}

/** Esegue `fn(client)` dentro una transazione, con rollback su errore. */
async function withTransaction(fn) {
  const p = getPool();
  if (!p) throw new Error("database non configurato");
  const client = await p.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function close() {
  if (pool) {
    const p = pool;
    pool = null;
    await p.end().catch(() => {});
  }
}

/** Inietta un pool alternativo (pg-mem nei test). */
function _setPool(p) {
  pool = p;
}

module.exports = { getPool, query, withTransaction, close, _setPool };
