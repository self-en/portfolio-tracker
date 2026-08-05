import logger from "../../logger";
import config from "../../config";
import * as fxRepo from "../../repo/fx";
import * as refresher from "../../market/refresher";
import { createProvider } from "../../market/provider";
import { err } from "../errors";
import { z, query, body, dateString } from "../validate";
import { createLimiter } from "../rateLimit";
import type { FastifyPluginAsync } from "fastify";


/**
 * LRU in memoria per /market/search: 200 voci, 10 minuti.
 *
 * `search` è UNA delle DUE sole eccezioni alla regola "gli handler HTTP non chiamano
 * mai un provider in modo sincrono" (l'altra è /refresh): è un'azione utente
 * esplicita, con debounce a 350 ms lato client. La cache evita che ogni battitura
 * ripetuta diventi una richiesta a Yahoo.
 */
const SEARCH_TTL_MS = 10 * 60 * 1000;
const SEARCH_MAX = 200;
const searchCache = new Map();

function cacheGet(key) {
  const hit = searchCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > SEARCH_TTL_MS) {
    searchCache.delete(key);
    return null;
  }
  // Rinfresca la posizione: Map itera in ordine di inserimento, quindi
  // cancellare-e-reinserire realizza l'LRU senza strutture aggiuntive.
  searchCache.delete(key);
  searchCache.set(key, hit);
  return hit.value;
}

function cacheSet(key, value) {
  searchCache.set(key, { at: Date.now(), value });
  while (searchCache.size > SEARCH_MAX) {
    searchCache.delete(searchCache.keys().next().value);
  }
}

const router: FastifyPluginAsync = async (app) => {
  app.get("/search", { preHandler: [query(z.object({ q: z.string().trim().min(2, "servono almeno 2 caratteri").max(80) }))] }, async (req, reply) => {
    const q = req.valid.query.q;
    const key = q.toUpperCase();

    const cached = cacheGet(key);
    if (cached) return reply.send({ items: cached, cached: true });

    try {
      const provider = createProvider();
      const items = await provider.resolveSymbol(q);
      cacheSet(key, items);
      return reply.send({ items, cached: false });
    } catch (e) {
      // Il provider giù non è un 500: è un upstream che non risponde, e la UI deve
      // poter dire "cerca non disponibile, inserisci il ticker a mano".
      logger.warn({ q, err: String(e.message).slice(0, 200) }, "[market] ricerca fallita");
      throw err("upstream_error", "il provider di mercato non è raggiungibile", {
        hint: "puoi inserire ticker e ISIN manualmente",
      });
    }
  });

  app.post("/refresh", { preHandler: [refreshLimiter.hook, body(z.object({ scope: z.enum(["quotes", "history", "fx", "events", "all"]).default("quotes") }))] }, async (req, reply) => {
    const jobId = refresher.enqueueScope(req.valid.body.scope);
    // 202: accodato, non eseguito. La UI mostra lo stato via /api/system/status.
    return reply.code(202).send({ accepted: true, jobId, scope: req.valid.body.scope });
  });

  app.get("/fx", { preHandler: [query(
    z.object({
      quotes: z
        .string()
        .optional()
        .transform((v) => (v ? v.split(",").map((x) => x.trim().toUpperCase()).filter(Boolean) : [])),
      date: dateString().optional(),
      from: dateString().optional(),
      to: dateString().optional(),
    })
  )] }, async (req, reply) => {
    const { quotes, date, from, to } = req.valid.query;
    const items = await fxRepo.list({ quotes, date, from, to });
    return reply.send({
      base: "EUR",
      // La convenzione va DICHIARATA nella risposta: è la fonte di errore numero uno
      // in un'app multivaluta.
      convention: "rate = unità di quote per 1 EUR; per convertire quote→EUR: importo / rate",
      items,
      coverage: await fxRepo.coverage(),
    });
  });

  app.get("/status", async (_req, reply) => {
    return reply.send({ provider: config.market.provider, refresher: refresher.status() });
  });
};

// 1 richiesta al minuto: è un'azione esplicita, non un polling.
const refreshLimiter = createLimiter({ windowMs: 60_000, max: 1, name: "market-refresh" });

export { router, searchCache as _searchCache };
