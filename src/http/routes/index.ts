// Montaggio di /api. L'ordine conta:
//   1. gate locked-mode   → 503 not_configured
//   2. /auth              → non autenticato per definizione
//   3. gate readiness DB  → 503 db_unavailable
//   4. requireAuth        → 401 su tutto il resto
//   5. le route di dominio
import express from "express";
import config from "../../config";
import { state } from "../../boot";
import { send } from "../errors";
import { requireAuth } from "../auth";
import { router as authRouter } from "./auth";
import { router as systemRouter } from "./system";
import { router as portfoliosRouter } from "./portfolios";
import { router as instrumentsRouter } from "./instruments";
import { router as transactionsRouter } from "./transactions";
import { router as portfolioRouter } from "./portfolio";
import { router as calendarRouter } from "./calendar";
import { router as marketRouter } from "./market";
import { router as exportImportRouter } from "./exportImport";
import type { NextFunction, Request, Response } from "express";

function buildApiRouter() {
  const api = express.Router();

  // 1. Locked mode: config incompleta. Nessuna password di default, nessun crash.
  api.use((_req: Request, res: Response, next: NextFunction) => {
    if (!config.locked) return next();
    return send(res, "not_configured", "l'applicazione non è configurata", {
      reasons: config.lockedReasons,
      hint: "imposta APP_PASSWORD e SESSION_SECRET (≥32 caratteri) nell'env del deployment",
    });
  });

  // 2. Auth: deve stare prima del gate readiness, altrimenti con il DB giù non si
  //    può nemmeno fare login per leggere /api/system/status.
  api.use("/auth", authRouter);

  // 3. Readiness del database. /api/system/status deve restare raggiungibile per
  //    poter DIAGNOSTICARE il 503, quindi è esentato dal gate.
  api.use((req: Request, res: Response, next: NextFunction) => {
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
  api.use("/system", systemRouter);

  // Un tempo montate con require() dentro un try/catch che tollerava
  // MODULE_NOT_FOUND, perché le fasi successive del piano dovevano ancora
  // aggiungerle e l'app doveva restare deployabile. Esistono tutte da un pezzo, e
  // con TypeScript quel giro dinamico costava il type-checking del montaggio in
  // cambio di niente: un import mancante ora è un errore di compilazione, non una
  // route che sparisce in silenzio a runtime.
  const mounted: Array<[string, express.Router]> = [
    ["/portfolios", portfoliosRouter],
    ["/instruments", instrumentsRouter],
    ["/transactions", transactionsRouter],
    ["/portfolio", portfolioRouter],
    ["/calendar", calendarRouter],
    ["/market", marketRouter],
    ["/", exportImportRouter],
  ];
  for (const [mount, router] of mounted) api.use(mount, router);

  // 404 in forma API per tutto ciò che non è stato raccolto: senza, un /api/typo
  // cadrebbe nel fallback SPA e riceverebbe index.html con status 200.
  api.use((_req: Request, res: Response) => send(res, "not_found", "endpoint non trovato"));

  return api;
}

export { buildApiRouter };
