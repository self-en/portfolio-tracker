// L'UNICO meccanismo di schema disponibile su questa piattaforma: la piattaforma
// non offre migrazioni, quindi l'app crea e migra le tabelle al boot, in modo
// idempotente, protetta da un advisory lock.
import crypto from "node:crypto";
import migrations from "./migrations";
import logger from "../logger";
import type { Pool } from "pg";

// Chiave arbitraria ma stabile: due pod che partono insieme devono contendersi lo
// stesso lock.
const MIGRATION_LOCK_KEY = 918273645;

const sha256 = (s: string): string => crypto.createHash("sha256").update(s, "utf8").digest("hex");

/**
 * Applica le migrazioni non ancora applicate. Idempotente.
 * @returns {Promise<{applied: string[], skipped: string[], mismatched: string[]}>}
 */
async function migrate(pool: Pool) {
  // Gli advisory lock di pg_advisory_lock sono SESSION-scoped: servono un client
  // dedicato tenuto per tutta la durata, non pool.query() (che può prendere un
  // client diverso per la lock e per la unlock, lasciando il lock appeso).
  const client = await pool.connect();
  const result: { applied: string[]; skipped: string[]; mismatched: string[] } = {
    applied: [],
    skipped: [],
    mismatched: [],
  };

  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);

    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);

    const { rows } = await client.query("SELECT version, checksum FROM schema_migrations");
    const applied = new Map<string, string>(rows.map((r) => [r.version as string, r.checksum as string]));

    for (const m of migrations) {
      const sum = sha256(m.sql);

      if (applied.has(m.version)) {
        if (applied.get(m.version) !== sum) {
          // Loggare e continuare, non crashare: su questa piattaforma un
          // crashloop è inosservabile, e uno schema leggermente alla deriva è
          // molto meno grave di un env che non parte.
          result.mismatched.push(m.version);
          logger.error(
            { version: m.version, expected: applied.get(m.version), actual: sum },
            "[migrate] checksum migrazione non coincide — una migrazione già applicata è stata modificata"
          );
        } else {
          result.skipped.push(m.version);
        }
        continue;
      }

      logger.info({ version: m.version }, "[migrate] applico la migrazione");
      await client.query("BEGIN");
      try {
        await client.query(m.sql);
        await client.query(
          "INSERT INTO schema_migrations (version, checksum) VALUES ($1,$2)",
          [m.version, sum]
        );
        await client.query("COMMIT");
        result.applied.push(m.version);
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      }
    }

    return result;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]).catch(() => {});
    client.release();
  }
}

/** Versioni conosciute dal codice, per /api/system/status. */
function knownVersions() {
  return migrations.map((m) => m.version);
}

export { migrate, knownVersions, MIGRATION_LOCK_KEY };
