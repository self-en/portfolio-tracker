// Boot asincrono: migrazioni (con retry), scheduler, reconciler.
//
// Viene chiamato DOPO app.listen(). Il pod deve diventare raggiungibile anche se
// il database non è pronto: il job PreSync che fa CREATE DATABASE può ancora
// essere in corso quando il pod parte, e una migrazione fallita che crasha il
// processo produce un crashloop senza modo di leggere i log dalla UI della
// piattaforma.
//
// `start()` NON LANCIA MAI.
import config from "./config";
import logger from "./logger";
import { getPool } from "./db/pool";
import { migrate, knownVersions } from "./db/migrate";
import { errMessage, errStack } from "./util/err";

// Backoff 2s → 4s → 8s → 16s → 30s. Cinque tentativi coprono ~60s di attesa, che
// è più di quanto serva al job PreSync.
const RETRY_DELAYS_MS = [2000, 4000, 8000, 16000, 30000];

const state = {
  ready: false,
  db: { configured: config.db.configured, connected: false, error: null },
  migrations: { applied: [], pending: knownVersions(), mismatched: [], error: null },
  scheduler: { enabled: config.scheduler.enabled, leader: false, lastRuns: {} },
  startedAt: new Date().toISOString(),
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runMigrations() {
  const pool = getPool();
  if (!pool) {
    state.db.error = "database non configurato (PGHOST/DATABASE_URL assenti)";
    logger.warn("[boot] nessun database configurato: /api/* risponderà 503 db_unavailable");
    return false;
  }

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const result = await migrate(pool);
      state.db.connected = true;
      state.db.error = null;
      state.migrations.applied = [...result.applied, ...result.skipped];
      state.migrations.mismatched = result.mismatched;
      state.migrations.pending = knownVersions().filter(
        (v) => !state.migrations.applied.includes(v)
      );
      state.migrations.error = null;
      logger.info(
        { applied: result.applied, skipped: result.skipped.length, attempt },
        "[boot] migrazioni completate"
      );
      return true;
    } catch (err) {
      const delay = RETRY_DELAYS_MS[attempt];
      state.db.connected = false;
      state.db.error = errMessage(err);
      state.migrations.error = errMessage(err);
      if (delay === undefined) {
        // Fallimento finale: si logga e si CONTINUA A SERVIRE. /healthz resta 200
        // (readiness della piattaforma), /api/* risponde 503 con il dettaglio in
        // /api/system/status. Un env diagnosticabile batte un crashloop muto.
        logger.error(
          { err: errMessage(err), attempts: attempt + 1 },
          "[boot] migrazioni fallite definitivamente — l'app resta su e serve 503 su /api/*"
        );
        return false;
      }
      logger.warn(
        { err: errMessage(err), attempt: attempt + 1, retryInMs: delay },
        "[boot] migrazione fallita, riprovo"
      );
      await sleep(delay);
    }
  }
  return false;
}

/** Avvia il boot asincrono. Non lancia mai. */
async function start() {
  if (config.locked) {
    logger.error(
      { reasons: config.lockedReasons },
      "[boot] locked mode: salto migrazioni e scheduler"
    );
    return state;
  }

  try {
    const ok = await runMigrations();
    state.ready = ok;

    if (!ok) return state;

    // Scheduler (che include catch-up e reconciler quando è leader).
    try {
      const { startScheduler } = await import("./market/scheduler");
      const result = await startScheduler(state);
      state.scheduler.leader = !!result.leader;
    } catch (err) {
      // Uno scheduler che non parte è un degrado, non un guasto: l'app resta
      // utilizzabile con i dati in cache e il refresh manuale.
      logger.error({ err: errMessage(err) }, "[boot] avvio scheduler fallito (continuo)");
    }

    // Reconciler anche a scheduler disabilitato (sviluppo locale): allinea la
    // copertura prezzi senza aspettare un cron.
    if (!config.scheduler.enabled) {
      try {
        const { reconcile } = await import("./market/refresher");
        await reconcile();
      } catch (err) {
        logger.warn({ err: errMessage(err) }, "[boot] reconciler fallito (continuo)");
      }
    }
  } catch (err) {
    // Cintura di sicurezza: qualunque cosa accada, il processo resta su.
    logger.error({ err: errMessage(err), stack: errStack(err) }, "[boot] errore inatteso nel boot");
  }

  return state;
}

export { start, state, runMigrations, RETRY_DELAYS_MS };
