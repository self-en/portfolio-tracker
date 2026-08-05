// Scheduler in-process con leader election via advisory lock.
//
// DECISIONE: node-cron + pg_try_advisory_lock, non un CronJob Kubernetes. Un
// CronJob sarebbe architetturalmente più pulito ma richiederebbe modifiche a
// chart/templates/ (che il README dice di toccare raramente), un secondo entrypoint
// e credenziali DB duplicate. `replicaCount` è 1 oggi, ma l'advisory lock rende
// questa soluzione *corretta* anche a 2+, che è l'unica obiezione reale.
//
// node-cron si guadagna il posto per `{ timezone: "Europe/Rome" }`: la
// schedulazione è genuinamente dipendente dal fuso e il container gira in UTC.
import cron from "node-cron";
import config from "../config";
import logger from "../logger";
import { Leadership, SCHEDULER_LOCK_KEY } from "../db/leader";
import * as refreshLog from "../repo/refreshLog";
import * as refresher from "./refresher";
import { errMessage } from "../util/err";

const LEADER_RETRY_MS = 60_000;

const leadership = new Leadership(SCHEDULER_LOCK_KEY, "scheduler");
let isLeader = false;
let tasks = [];
let leaderTimer = null;
let bootState = null;

/** Aggiorna lo stato di leadership. La meccanica del lock vive in db/leader.js. */
async function tryBecomeLeader() {
  isLeader = await leadership.tryAcquire();
  if (bootState) bootState.scheduler.leader = isLeader;
  return isLeader;
}

/** Avvolge un corpo di cron: esce subito se non è leader, e non lancia mai. */
function leaderOnly(name, fn) {
  return async () => {
    if (!isLeader) return;
    try {
      logger.info({ job: name }, "[scheduler] avvio job");
      await fn();
    } catch (err) {
      // Un'eccezione da un cron non gestita ucciderebbe il processo.
      logger.error({ job: name, err: errMessage(err) }, "[scheduler] job fallito");
    }
  };
}

/**
 * Catch-up al boot: si controlla l'ultimo successo di ogni job e si esegue subito se
 * è stale da più di un intervallo.
 *
 * Serve perché i pod ripartono a ogni push: senza, un deploy alle 23:20 farebbe
 * saltare del tutto le chiusure giornaliere delle 23:15.
 */
const CATCHUP_MAX_AGE_MS = {
  quotes: 60 * 60 * 1000, // 1 ora
  fx: 26 * 60 * 60 * 1000, // giornaliero + margine
  history: 26 * 60 * 60 * 1000,
  events: 26 * 60 * 60 * 1000,
};

async function catchUp() {
  for (const [job, maxAge] of Object.entries(CATCHUP_MAX_AGE_MS)) {
    try {
      const last = await refreshLog.lastSuccess(job);
      const age = last?.startedAt ? Date.now() - new Date(last.startedAt).getTime() : Infinity;
      if (age > maxAge) {
        logger.info(
          { job, ageHours: Number.isFinite(age) ? Math.round(age / 3600000) : null },
          "[scheduler] catch-up al boot: job stale, eseguo subito"
        );
        refresher.enqueueScope(job);
      }
    } catch (err) {
      logger.warn({ job, err: errMessage(err) }, "[scheduler] catch-up fallito per questo job");
    }
  }
}

async function startScheduler(state) {
  bootState = state || null;

  if (!config.scheduler.enabled) {
    logger.info("[scheduler] disabilitato (SCHEDULER_ENABLED=false)");
    return { enabled: false };
  }

  const tz = config.scheduler.timezone;

  // Verifica esplicita del fuso: il container non ha TZ, quindi node gira in UTC
  // mentre i cron dicono Europe/Rome. node:24-alpine include full-ICU, quindi le
  // zone nominate *dovrebbero* funzionare — questo log lo dimostra invece di
  // presumerlo (§9.7 del piano). Se qui comparisse UTC, il rimedio è
  // `RUN apk add --no-cache tzdata` nel Dockerfile.
  try {
    const local = new Date().toLocaleString("it-IT", { timeZone: tz });
    const utc = new Date().toISOString();
    logger.info({ timezone: tz, local, utc, tzEnv: process.env.TZ || null }, "[scheduler] fuso orario");
  } catch (err) {
    logger.error(
      { timezone: tz, err: errMessage(err) },
      "[scheduler] fuso non risolvibile: ICU incompleto, aggiungi tzdata all'immagine"
    );
  }

  await tryBecomeLeader();
  leaderTimer = setInterval(() => void tryBecomeLeader(), LEADER_RETRY_MS);
  if (typeof leaderTimer.unref === "function") leaderTimer.unref();

  const opts = { timezone: tz };

  tasks = [
    // Quotazioni: ogni 15 minuti in orario di mercato (09:00–22:30 lun–ven, che
    // copre le borse europee e l'apertura USA), altrimenti ogni ora.
    cron.schedule("*/15 9-22 * * 1-5", leaderOnly("quotes", refresher.refreshQuotes), opts),
    cron.schedule("0 * * * *", leaderOnly("quotes-orarie", refresher.refreshQuotes), opts),
    // Chiusure giornaliere: 23:15, dopo la chiusura europea e quella USA.
    cron.schedule("15 23 * * *", leaderOnly("history", refresher.refreshDailyCloses), opts),
    // FX: 16:30, la BCE pubblica intorno alle 16:00 CET.
    cron.schedule("30 16 * * *", leaderOnly("fx", () => refresher.refreshFx({})), opts),
    // Dividendi imminenti: 06:00.
    cron.schedule("0 6 * * *", leaderOnly("events", refresher.refreshUpcomingEvents), opts),
    // Potatura del log di refresh, settimanale.
    cron.schedule("0 4 * * 0", leaderOnly("prune", () => refreshLog.prune(30)), opts),
  ];

  logger.info({ timezone: tz, tasks: tasks.length }, "[scheduler] cron registrati");

  // Catch-up e reconciler solo per il leader: due pod che riaccodano gli stessi
  // backfill sarebbero spreco.
  if (isLeader) {
    await catchUp();
    await refresher.reconcile();
  }

  return { enabled: true, leader: isLeader, tasks: tasks.length };
}

async function stopScheduler() {
  for (const t of tasks) {
    try {
      t.stop();
    } catch {
      /* ignora */
    }
  }
  tasks = [];
  if (leaderTimer) clearInterval(leaderTimer);
  leaderTimer = null;
  await leadership.release();
  isLeader = false;
}

const isLeaderFn = (): boolean => isLeader;

export { startScheduler, stopScheduler, catchUp, SCHEDULER_LOCK_KEY, isLeaderFn as isLeader };
