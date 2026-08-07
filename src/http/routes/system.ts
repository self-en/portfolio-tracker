import config from "../../config";
import { state } from "../../boot";
import { knownVersions } from "../../db/migrate";

import * as refreshLog from "../../repo/refreshLog";
import * as analysesRepo from "../../repo/analyses";
import type { FastifyPluginAsync } from "fastify";


// Diagnostica. Autenticata (monta sotto requireAuth) tranne per la parte che
// serve alla schermata di configurazione: quando l'app è in locked mode il gate
// 503 scatta prima, quindi questo endpoint è raggiungibile solo quando la config
// è a posto — la SPA legge lo stato di lock dal codice d'errore 503.
const router: FastifyPluginAsync = async (app) => {
  app.get("/status", async (_req, reply) => {
    const warnings = [];
    if (config.locked) warnings.push({ code: "not_configured", details: config.lockedReasons });
    if (state.migrations.mismatched.length) {
      warnings.push({ code: "migration_checksum_mismatch", details: state.migrations.mismatched });
    }
    if (!state.ready) warnings.push({ code: "db_unavailable", details: state.db.error });

    let lastRuns = {};
    let analysesCount: number | null = null;
    if (state.ready) {
      try {
        // Ultimo esito per job, per rendere osservabile lo scheduler senza Grafana.
        // Passa dal repo: le route non contengono SQL (docs/decisions.md §7, e c'è
        // un test che lo verifica).
        lastRuns = await refreshLog.lastRuns();
      } catch {
        // refresh_log può non esistere ancora: non è un errore da propagare.
      }
      try {
        analysesCount = await analysesRepo.count();
      } catch {
        // instrument_analyses può non esistere ancora (migrazione 004 non applicata):
        // la diagnostica deve restare leggibile proprio in quel caso.
      }
    }

    return reply.send({
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
      // Analisi con Claude: `configured: false` è uno stato NORMALE (la funzione è
      // opzionale), quindi non produce un warning — ma va reso osservabile, insieme a
      // quante analisi sono già state pagate.
      ai: {
        configured: config.ai.configured,
        model: config.ai.model,
        effort: config.ai.effort,
        analyses: analysesCount,
      },
      // Utile per diagnosticare il fuso: il container gira in UTC ma i cron
      // dicono Europe/Rome (verifica §9.7).
      time: {
        utc: new Date().toISOString(),
        local: new Date().toLocaleString("it-IT", { timeZone: config.scheduler.timezone }),
        tzEnv: config.tz,
      },
      warnings,
    });
  });
};

export { router };
