// Montaggio di /api. L'ordine conta:
//   1. gate locked-mode   → 503 not_configured
//   2. /auth              → non autenticato per definizione
//   3. gate readiness DB  → 503 db_unavailable
//   4. requireAuth        → 401 su tutto il resto
//   5. le route di dominio
const express = require("express");
const config = require("../../config");
const { state } = require("../../boot");
const { send } = require("../errors");
const { requireAuth } = require("../auth");

function buildApiRouter() {
  const api = express.Router();

  // 1. Locked mode: config incompleta. Nessuna password di default, nessun crash.
  api.use((_req, res, next) => {
    if (!config.locked) return next();
    return send(res, "not_configured", "l'applicazione non è configurata", {
      reasons: config.lockedReasons,
      hint: "imposta APP_PASSWORD e SESSION_SECRET (≥32 caratteri) nell'env del deployment",
    });
  });

  // 2. Auth: deve stare prima del gate readiness, altrimenti con il DB giù non si
  //    può nemmeno fare login per leggere /api/system/status.
  api.use("/auth", require("./auth").router);

  // 3. Readiness del database. /api/system/status deve restare raggiungibile per
  //    poter DIAGNOSTICARE il 503, quindi è esentato dal gate.
  api.use((req, res, next) => {
    if (state.ready) return next();
    if (req.path === "/system/status") return next();
    return send(res, "db_unavailable", "database non disponibile", {
      error: state.db.error,
      hint: "vedi GET /api/system/status",
    });
  });

  // 4. Da qui in giù serve una sessione.
  api.use(requireAuth);

  // 5. Route di dominio.
  api.use("/system", require("./system").router);

  const optional = [
    ["/portfolios", "./portfolios"],
    ["/instruments", "./instruments"],
    ["/transactions", "./transactions"],
    ["/portfolio", "./portfolio"],
    ["/calendar", "./calendar"],
    ["/market", "./market"],
    ["/", "./exportImport"],
  ];
  for (const [mount, mod] of optional) {
    // Le fasi successive aggiungono questi file; finché non esistono l'app resta
    // deployabile (il piano deploya la Fase 1 immediatamente).
    let router;
    try {
      router = require(mod).router;
    } catch (err) {
      if (err?.code === "MODULE_NOT_FOUND") continue;
      throw err;
    }
    api.use(mount, router);
  }

  // 404 in forma API per tutto ciò che non è stato raccolto: senza, un /api/typo
  // cadrebbe nel fallback SPA e riceverebbe index.html con status 200.
  api.use((_req, res) => send(res, "not_found", "endpoint non trovato"));

  return api;
}

module.exports = { buildApiRouter };
