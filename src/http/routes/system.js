const express = require("express");
const config = require("../../config");
const { state } = require("../../boot");
const { knownVersions } = require("../../db/migrate");
const { asyncHandler } = require("../errors");
const { query: dbQuery } = require("../../db/pool");

const router = express.Router();

// Diagnostica. Autenticata (monta sotto requireAuth) tranne per la parte che
// serve alla schermata di configurazione: quando l'app è in locked mode il gate
// 503 scatta prima, quindi questo endpoint è raggiungibile solo quando la config
// è a posto — la SPA legge lo stato di lock dal codice d'errore 503.
router.get(
  "/status",
  asyncHandler(async (_req, res) => {
    const warnings = [];
    if (config.locked) warnings.push({ code: "not_configured", details: config.lockedReasons });
    if (state.migrations.mismatched.length) {
      warnings.push({ code: "migration_checksum_mismatch", details: state.migrations.mismatched });
    }
    if (!state.ready) warnings.push({ code: "db_unavailable", details: state.db.error });

    let lastRuns = {};
    if (state.ready) {
      try {
        // Ultimo esito per job, per rendere osservabile lo scheduler senza Grafana.
        const { rows } = await dbQuery(
          `SELECT job, started_at, finished_at, ok, error, row_count
             FROM refresh_log r
            WHERE started_at = (SELECT MAX(started_at) FROM refresh_log WHERE job = r.job)
            ORDER BY job`
        );
        lastRuns = Object.fromEntries(
          rows.map((r) => [
            r.job,
            {
              startedAt: r.started_at,
              finishedAt: r.finished_at,
              ok: r.ok,
              error: r.error,
              rowCount: r.row_count,
            },
          ])
        );
      } catch {
        // refresh_log può non esistere ancora: non è un errore da propagare.
      }
    }

    return res.json({
      ready: state.ready,
      startedAt: state.startedAt,
      db: {
        configured: state.db.configured,
        connected: state.db.connected,
        error: state.db.error,
      },
      migrations: {
        applied: state.migrations.applied,
        pending: state.migrations.pending,
        known: knownVersions(),
        mismatched: state.migrations.mismatched,
        error: state.migrations.error,
      },
      scheduler: {
        enabled: state.scheduler.enabled,
        leader: state.scheduler.leader,
        timezone: config.scheduler.timezone,
        lastRuns,
      },
      provider: config.market.provider,
      // Utile per diagnosticare il fuso: il container gira in UTC ma i cron
      // dicono Europe/Rome (verifica §9.7).
      time: {
        utc: new Date().toISOString(),
        local: new Date().toLocaleString("it-IT", { timeZone: config.scheduler.timezone }),
        tzEnv: process.env.TZ || null,
      },
      warnings,
    });
  })
);

module.exports = { router };
