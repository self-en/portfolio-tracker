import logger from "../../logger";
import * as instrumentsRepo from "../../repo/instruments";
import * as pricesRepo from "../../repo/prices";
import * as eventsRepo from "../../repo/events";
import * as analysesRepo from "../../repo/analyses";
import * as bonds from "../../domain/bonds";
import { money } from "../../domain/money";
import { notFound, conflict, validation } from "../errors";
import { z, body, query, params, parse, idParam, dateString } from "../validate";
import * as schemas from "../schemas";
import { errCode, errMessage } from "../../util/err";
import { enqueueBackfill } from "../../market/refresher";
import type { FastifyPluginAsync } from "fastify";
import type { Instrument } from "../../types";


/** Il rateo obbligazionario e lo scadenzario sono utili nella risposta, non solo in UI. */
function withBondDetails(inst: Instrument | null) {
  if (!inst) return inst;
  const out: Record<string, any> = {
    id: inst.id,
    assetClass: inst.assetClass,
    name: inst.name,
    ticker: inst.ticker,
    isin: inst.isin,
    exchange: inst.exchange,
    currency: inst.currency,
    priceSource: inst.priceSource,
    quoteConvention: inst.quoteConvention,
    issuer: inst.issuer,
    notes: inst.notes,
    active: inst.active,
    metadata: inst.metadata,
    createdAt: inst.createdAt,
    updatedAt: inst.updatedAt,
  };
  if (inst.assetClass === "BOND" || inst.faceValue != null) {
    out.bond = {
      faceValue: inst.faceValue,
      couponRate: inst.couponRate,
      couponFrequency: inst.couponFrequency,
      firstCouponDate: inst.firstCouponDate,
      maturityDate: inst.maturityDate,
      dayCount: inst.dayCount,
    };
  }
  return out;
}

/**
 * Rigenera gli eventi PROIETTATI di un'obbligazione dallo scadenzario.
 *
 * È IL MECCANISMO che fa funzionare il calendario cedole: Yahoo non restituisce
 * NULLA per i BTP (verificato in Fase 0 — tre ISIN, tutti `quotes: []`), quindi le
 * cedole future esistono solo perché le calcoliamo noi.
 */
async function regenerateProjected(inst: Instrument) {
  if (inst.assetClass !== "BOND" || !inst.maturityDate) return 0;
  try {
    const events = bonds.projectedEvents(inst, null).map((e) => ({
      kind: e.kind,
      status: "PROJECTED",
      exDate: null as string | null,
      payDate: e.payDate,
      amountPerUnit: e.amountPerUnit,
      currency: inst.currency,
      source: "schedule",
    }));
    const n = await eventsRepo.replaceProjected(inst.id, events);
    logger.info({ instrumentId: inst.id, events: n }, "[instruments] cedole proiettate rigenerate");
    return n;
  } catch (err) {
    // Uno scadenzario non generabile non deve impedire il salvataggio dello
    // strumento: si logga e si va avanti.
    logger.error(
      { instrumentId: inst.id, err: errMessage(err) },
      "[instruments] rigenerazione cedole proiettate fallita"
    );
    return 0;
  }
}

const router: FastifyPluginAsync = async (app) => {
  app.get("/", { preHandler: [query(schemas.listInstrumentsQuery)] }, async (req, reply) => {
    const list = await instrumentsRepo.list(req.valid.query);
    const ids = list.map((i) => i.id);
    // Una query per tutta la lista, non una per riga: l'ultima analisi serve alla
    // colonna "Analisi" della pagina strumenti.
    const [quotes, analyses] = await Promise.all([
      pricesRepo.latestQuotes(ids),
      analysesRepo.latestForMany(ids),
    ]);
    return reply.send({
      items: list.map((i) => {
        const q = quotes.get(i.id);
        const a = analyses.get(i.id);
        return {
          ...withBondDetails(i),
          // Solo il verdetto e la data: la scheda intera si legge nel dettaglio.
          latestAnalysis: a
            ? {
                id: a.id,
                verdict: a.verdict,
                confidence: a.confidence,
                headline: a.headline,
                createdAt: a.createdAt,
              }
            : null,
          latestQuote: q
            ? {
                price: q.price,
                currency: q.currency,
                previousClose: q.previousClose,
                asOf: q.fetchedAt,
                marketState: q.marketState,
                source: q.source,
              }
            : null,
        };
      }),
    });
  });

  app.post("/", { preHandler: [body(schemas.createInstrument)] }, async (req, reply) => {
    const input = req.valid.body;

    // Un duplicato è un conflitto, non un errore interno: il messaggio dice quale
    // strumento esiste già.
    const existing = await instrumentsRepo.byIsinOrTicker(input);
    if (existing) {
      throw conflict("esiste già uno strumento con questo ISIN o ticker", {
        id: existing.id,
        name: existing.name,
        isin: existing.isin,
        ticker: existing.ticker,
      });
    }

    const created = await instrumentsRepo.create(input);
    await regenerateProjected(created!);

    // 201 SUBITO, backfill in background: uno `chart` di 2 anni non deve far
    // aspettare il form (§4.4 — gli handler HTTP non chiamano provider in modo
    // sincrono).
    try {
      enqueueBackfill(created!.id);
    } catch (err) {
      if (errCode(err) !== "MODULE_NOT_FOUND") throw err;
    }

    return reply.code(201).send(withBondDetails(created));
  });

  app.get("/:id", { preHandler: [params(z.object({ id: idParam() }))] }, async (req, reply) => {
    const inst = await instrumentsRepo.byId(req.valid.params.id);
    if (!inst) throw notFound("strumento non trovato");

    const [coverage, quotes] = await Promise.all([
      instrumentsRepo.priceCoverage(inst.id),
      pricesRepo.latestQuotes([inst.id]),
    ]);

    const out: Record<string, any> = { ...withBondDetails(inst), priceCoverage: coverage };
    const q = quotes.get(inst.id);
    if (q) {
      out.latestQuote = {
        price: q.price,
        currency: q.currency,
        previousClose: q.previousClose,
        asOf: q.fetchedAt,
        marketState: q.marketState,
        source: q.source,
      };
    }

    if (inst.assetClass === "BOND" && inst.maturityDate) {
      try {
        out.couponSchedule = bonds.couponSchedule(inst);
        if (q?.price) out.currentYield = bonds.currentYield(inst, q.price);
      } catch (err) {
        out.couponSchedule = [];
        out.warnings = [{ code: "schedule_error", message: errMessage(err) }];
      }
    }

    return reply.send(out);
  });

  app.patch("/:id", { preHandler: [params(z.object({ id: idParam() })), body(schemas.updateInstrument)] }, async (req, reply) => {
    const id = req.valid.params.id;
    const existing = await instrumentsRepo.byId(id);
    if (!existing) throw notFound("strumento non trovato");

    // Si rivalida il record COMPLETO: una PATCH parziale può rompere le invarianti
    // obbligazionarie (togliere la frequenza cedolare a un bond) e le refine
    // vedono solo l'oggetto che ricevono.
    const merged = { ...existing, ...req.valid.body };
    parse(schemas.refineInstrument(z.object({}).passthrough()), merged, "strumento aggiornato");

    const updated = await instrumentsRepo.update(id, req.valid.body);

    // Se sono cambiati i campi che definiscono lo scadenzario, le cedole proiettate
    // vanno rigenerate: altrimenti il calendario mostrerebbe le vecchie.
    const bondFields = ["couponRate", "couponFrequency", "firstCouponDate", "maturityDate", "dayCount", "faceValue"];
    if (bondFields.some((f) => req.valid.body[f] !== undefined)) {
      await regenerateProjected(updated!);
    }

    return reply.send(withBondDetails(updated));
  });

  app.delete("/:id", { preHandler: [params(z.object({ id: idParam() }))] }, async (req, reply) => {
    const id = req.valid.params.id;
    const inst = await instrumentsRepo.byId(id);
    if (!inst) throw notFound("strumento non trovato");

    // 409 e non una cancellazione a cascata: perdere movimenti per un click è
    // irreparabile in un'app a inserimento manuale.
    const n = await instrumentsRepo.transactionCount(id);
    if (n > 0) {
      throw conflict(
        `lo strumento ha ${n} movimenti collegati: elimina prima i movimenti, oppure disattivalo`,
        { transactionCount: n, hint: "PATCH { active: false }" }
      );
    }

    await instrumentsRepo.remove(id);
    return reply.code(204).send();
  });

  app.get("/:id/prices", { preHandler: [params(z.object({ id: idParam() })), query(z.object({ from: dateString().optional(), to: dateString().optional() }))] }, async (req, reply) => {
    const inst = await instrumentsRepo.byId(req.valid.params.id);
    if (!inst) throw notFound("strumento non trovato");
    const series = await pricesRepo.series(inst.id, req.valid.query);
    return reply.send({
      items: series.map((p) => ({ date: p.date, close: p.close, source: p.source })),
      currency: inst.currency,
      quoteConvention: inst.quoteConvention,
    });
  });

  app.put("/:id/prices", { preHandler: [params(z.object({ id: idParam() })), body(schemas.manualPriceBody)] }, async (req, reply) => {
    const inst = await instrumentsRepo.byId(req.valid.params.id);
    if (!inst) throw notFound("strumento non trovato");
    const { date, close } = req.valid.body;
    const saved = await pricesRepo.upsertManual(inst.id, date, close);

    // Un prezzo manuale è anche la quotazione corrente se è il più recente:
    // altrimenti la dashboard mostrerebbe il bond senza valore.
    const coverage = await instrumentsRepo.priceCoverage(inst.id);
    if (coverage.to === date) {
      await pricesRepo.upsertQuote({
        instrumentId: inst.id,
        price: close,
        currency: inst.currency,
        source: "manual",
        quoteTime: `${date}T00:00:00Z`,
      });
    }

    return reply.send({ date: saved!.date, close: saved!.close, source: saved!.source });
  });

  app.post("/:id/refresh", { preHandler: [params(z.object({ id: idParam() }))] }, async (req, reply) => {
    const inst = await instrumentsRepo.byId(req.valid.params.id);
    if (!inst) throw notFound("strumento non trovato");
    if (inst.priceSource === "manual") {
      throw validation("lo strumento ha prezzo manuale: non c'è nulla da aggiornare online", {
        hint: "usa PUT /api/instruments/:id/prices",
      });
    }
    let jobId = null;
    try {
      jobId = enqueueBackfill(inst.id, {});
    } catch (err) {
      if (errCode(err) !== "MODULE_NOT_FOUND") throw err;
    }
    return reply.code(202).send({ accepted: true, jobId });
  });
};

// Prezzo manuale. È IL PERCORSO PRINCIPALE PER LE OBBLIGAZIONI, non un fallback:
// la copertura Yahoo sui BTP è zero.

export { router, regenerateProjected, withBondDetails };
