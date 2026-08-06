// Montaggio di /api. L'ordine conta:
//   1. gate locked-mode   → 503 not_configured
//   2. /auth              → non autenticato per definizione
//   3. gate readiness DB  → 503 db_unavailable
//   4. requireAuth        → 401 su tutto il resto
//   5. le route di dominio
//
// In Express l'ordine era quello dei `app.use()` sullo stesso router. In Fastify
// un hook vale per il contesto in cui è registrato e per i suoi figli, quindi
// l'ordine si esprime con l'ANNIDAMENTO: le route autenticate vivono in un
// contesto figlio che aggiunge i propri hook, mentre /auth sta nel contesto padre
// e quegli hook non li vede. È più esplicito del "conta la riga in cui l'hai
// scritto", che era la trappola della versione Express.
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import config from "../../config";
import { state } from "../../boot";
import { send } from "../errors";
import { requireAuth } from "../auth";
import { router as authRouter } from "./auth";
import { router as systemRouter } from "./system";
import { router as portfoliosRouter } from "./portfolios";
import { router as instrumentsRouter } from "./instruments";
import { router as analysisRouter } from "./analysis";
import { router as transactionsRouter } from "./transactions";
import { router as portfolioRouter } from "./portfolio";
import { router as calendarRouter } from "./calendar";
import { router as marketRouter } from "./market";
import { router as exportImportRouter } from "./exportImport";

const buildApiRouter: FastifyPluginAsync = async (api) => {
  // 1. Locked mode: config incompleta. Nessuna password di default, nessun crash.
  //    Vale per TUTTO /api, /auth compreso: senza configurazione non c'è nemmeno
  //    un segreto con cui firmare una sessione.
  api.addHook("onRequest", async (_req, reply) => {
    if (!config.locked) return;
    return send(reply, "not_configured", "l'applicazione non è configurata", {
      reasons: config.lockedReasons,
      hint: "imposta APP_PASSWORD e SESSION_SECRET (≥32 caratteri) nell'env del deployment",
    });
  });

  // 2. Auth: fuori dal contesto autenticato, altrimenti con il DB giù non si
  //    potrebbe nemmeno fare login per leggere /api/system/status.
  await api.register(authRouter, { prefix: "/auth" });

  // 3-5. Tutto il resto: gate readiness + sessione richiesta.
  await api.register(async (secured: FastifyInstance) => {
    // 3. Readiness del database. /api/system/status deve restare raggiungibile per
    //    poter DIAGNOSTICARE il 503, quindi è esentato dal gate.
    secured.addHook("onRequest", async (req, reply) => {
      if (state.ready) return;
      if (req.url.startsWith("/api/system/status")) return;
      return send(reply, "db_unavailable", "database non disponibile", {
        error: state.db.error,
        hint: "vedi GET /api/system/status",
      });
    });

    // 4. Da qui in giù serve una sessione.
    secured.addHook("onRequest", requireAuth);

    // 5. Route di dominio.
    await secured.register(systemRouter, { prefix: "/system" });
    await secured.register(portfoliosRouter, { prefix: "/portfolios" });
    await secured.register(instrumentsRouter, { prefix: "/instruments" });
    // Stesso prefisso, file separato: l'analisi con Claude ha un contesto da
    // assemblare che non c'entra niente con l'anagrafica degli strumenti.
    await secured.register(analysisRouter, { prefix: "/instruments" });
    await secured.register(transactionsRouter, { prefix: "/transactions" });
    await secured.register(portfolioRouter, { prefix: "/portfolio" });
    await secured.register(calendarRouter, { prefix: "/calendar" });
    await secured.register(marketRouter, { prefix: "/market" });
    await secured.register(exportImportRouter);
  });

  // Il 404 in forma API per /api/typo NON è più qui: in Fastify lo serve il
  // notFoundHandler globale (src/static.ts), che distingue le rotte API dal
  // fallback SPA. Registrarne uno anche qui lo sovrascriverebbe per questo
  // contesto, con due punti da tenere allineati invece di uno.
};

export { buildApiRouter };
