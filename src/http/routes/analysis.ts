// Analisi di bilancio di un singolo strumento, con Claude.
//
//   GET  /api/instruments/:id/analysis   ultima analisi + storico (nessun costo)
//   POST /api/instruments/:id/analysis   ne genera una nuova (COSTA: chiamata a pagamento)
//
// Vive in un file suo e non dentro `instruments.ts` perché l'assemblaggio del
// contesto è il grosso del lavoro: strumento, quotazione, storico prezzi, metriche
// di rischio, fondamentali dal provider, posizione in portafoglio. Il modulo
// `src/ai/` riceve quel contesto già pronto e non sa da dove venga.
//
// ATTENZIONE — la regola sul provider: gli handler HTTP non chiamano MAI un provider
// di mercato in modo sincrono, con TRE eccezioni, tutte azioni utente esplicite:
// `GET /market/search`, `POST /market/refresh` e questo `POST`. Qui la deroga è
// giustificata due volte: l'utente ha appena premuto un pulsante e sta guardando lo
// spinner, e i fondamentali servono ADESSO per costruire il prompt — accodarli
// significherebbe generare l'analisi su dati che arriveranno dopo.
import logger from "../../logger";
import config from "../../config";
import * as instrumentsRepo from "../../repo/instruments";
import * as portfoliosRepo from "../../repo/portfolios";
import * as txRepo from "../../repo/transactions";
import * as pricesRepo from "../../repo/prices";
import * as analysesRepo from "../../repo/analyses";
import * as bonds from "../../domain/bonds";
import { addMonthsPreserveEom } from "../../domain/calendar";
import { riskMetrics } from "../../domain/riskMetrics";
import { createProvider } from "../../market/provider";
import { analyzeInstrument } from "../../ai/instrumentAnalysis";
import { contextGaps } from "../../ai/prompt";
import { AiError, isConfigured } from "../../ai/client";
import { loadValuation, today } from "./portfolio";
import * as S from "../serialize";
import { err, notFound } from "../errors";
import { z, params, query, idParam } from "../validate";
import { createLimiter } from "../rateLimit";
import { errMessage } from "../../util/err";
import type { FastifyPluginAsync } from "fastify";
import type { Instrument, InstrumentAnalysis } from "../../types";
import type { AnalysisContext } from "../../ai/prompt";

/**
 * Quanto storico prezzi passare alle metriche di rischio.
 *
 * Tre anni: bastano a un drawdown e a una volatilità sensati, e restano poche
 * centinaia di righe — l'intero storico su un titolo vecchio sarebbe migliaia di
 * punti per non cambiare nessuna delle metriche calcolate.
 */
const RISK_YEARS = 3;
/** Cedole future da passare al prompt: oltre due anni non aggiungono niente al giudizio. */
const SCHEDULE_ROWS = 6;

/**
 * Un'analisi in uscita.
 *
 * `context` NON viaggia intero: è lo snapshot completo dei dati di ingresso (utile
 * in database, per rileggere il verdetto tra sei mesi) e ripeterlo in ogni risposta
 * manderebbe in pagina un JSON di decine di kilobyte che nessuno legge. Se ne
 * espone il riassunto: quando, su quali dati, con quali lacune.
 */
function serialize(a: InstrumentAnalysis) {
  const ctx = (a.context || {}) as Partial<AnalysisContext> & { gaps?: string[] };
  return {
    id: a.id,
    instrumentId: a.instrumentId,
    createdAt: a.createdAt,
    model: a.model,
    effort: a.effort,
    servedBy: a.usage?.servedBy ?? null,
    verdict: a.verdict,
    confidence: a.confidence,
    headline: a.headline,
    analysis: a.analysis,
    usage: { inputTokens: a.usage?.inputTokens ?? null, outputTokens: a.usage?.outputTokens ?? null },
    // Su cosa è stata fatta: senza questo l'utente non può giudicare il giudizio.
    basis: {
      generatedAt: ctx.generatedAt ?? a.createdAt,
      provider: ctx.provider ?? null,
      quotePrice: ctx.quote?.price ?? null,
      quoteAsOf: ctx.quote?.asOf ?? null,
      fundamentalsAsOf: ctx.fundamentals?.asOf ?? null,
      priceRows: ctx.priceCoverage?.rows ?? null,
      hadPosition: !!ctx.position,
      gaps: ctx.gaps ?? [],
    },
  };
}

/** La voce ridotta dello storico: serve a scegliere, non a leggere. */
const serializeBrief = (a: InstrumentAnalysis) => ({
  id: a.id,
  createdAt: a.createdAt,
  verdict: a.verdict,
  confidence: a.confidence,
  headline: a.headline,
  model: a.model,
});

/** I campi obbligazionari nella forma che il prompt dichiara. */
function bondOf(inst: Instrument): AnalysisContext["bond"] {
  if (inst.assetClass !== "BOND" && inst.faceValue == null) return null;
  return {
    faceValue: inst.faceValue,
    couponRate: inst.couponRate,
    couponFrequency: inst.couponFrequency,
    firstCouponDate: inst.firstCouponDate,
    maturityDate: inst.maturityDate,
    dayCount: inst.dayCount,
  };
}

/**
 * Costruisce il contesto dell'analisi.
 *
 * Un guasto sui fondamentali NON fa fallire l'analisi: diventa una lacuna
 * dichiarata. È la stessa scelta dei prezzi mancanti (docs/decisions.md §5) — un
 * dato assente si dice, non si finge.
 */
async function buildContext(inst: Instrument): Promise<AnalysisContext & { gaps: string[] }> {
  const at = today();
  const provider = createProvider();

  const [coverage, quotes, series] = await Promise.all([
    instrumentsRepo.priceCoverage(inst.id),
    pricesRepo.latestQuotes([inst.id]),
    pricesRepo.series(inst.id, { from: addMonthsPreserveEom(at, -12 * RISK_YEARS), to: at }),
  ]);

  let fundamentals: AnalysisContext["fundamentals"] = null;
  // Niente ticker o prezzo manuale: non c'è nulla da chiedere. Sui BTP la copertura
  // del provider è zero (docs/decisions.md §9), quindi interrogarlo sarebbe solo un
  // secondo di attesa e un po' di rate limit buttati.
  if (inst.ticker && inst.priceSource !== "manual") {
    try {
      fundamentals = await provider.getFundamentals(inst.ticker);
    } catch (e) {
      logger.warn(
        { instrumentId: inst.id, ticker: inst.ticker, err: errMessage(e).slice(0, 200) },
        "[analysis] fondamentali non recuperati: l'analisi continua senza"
      );
    }
  }

  // La posizione: si riusa lo STESSO percorso di /api/portfolio/positions, così il
  // costo medio che il modello legge è identico a quello che l'utente vede.
  let position: AnalysisContext["position"] = null;
  let portfolio: AnalysisContext["portfolio"] = null;
  let portfolioValue: string | null = null;
  // Lacune che solo il layer HTTP può conoscere, perché nascono da ciò che c'è nel
  // database e non dalla forma del contesto.
  const extraGaps: string[] = [];
  try {
    // QUALE portafoglio: `loadValuation()` senza id cade sul primo, e su un titolo
    // detenuto nel secondo produrrebbe `position: null` — cioè direbbe al modello
    // "non lo possiedi" mentre lo possiedi, e calcolerebbe il peso su un totale che
    // non è quello giusto. Un dato FALSO in una chiamata a pagamento, non un dato
    // mancante.
    //
    // Si parte dal ledger (una query, nessuna valorizzazione) per sapere dove il
    // titolo è movimentato, e si valorizza SOLO quel portafoglio: valorizzarli tutti
    // significherebbe ricaricare prezzi e cambi per ognuno.
    const portfolios = await portfoliosRepo.list();
    const holders = [
      ...new Set((await txRepo.ledger({ instrumentId: inst.id, asOf: at })).map((t) => t.portfolioId)),
    ];
    const chosen = portfolios.find((p) => p && holders.includes(p.id)) ?? portfolios[0];

    const valuation = await loadValuation({ portfolioId: chosen?.id, asOf: at });
    portfolio = { id: valuation.portfolio.id, name: valuation.portfolio.name };
    portfolioValue = S.m(valuation.valued.totals.totalValue);
    const row = valuation.valued.rows.find((r: any) => Number(r.instrumentId ?? r.instrument?.id) === inst.id);
    if (row) position = S.position(row) as unknown as Record<string, unknown>;

    // Se il titolo è movimentato in più portafogli, l'analisi ne vede uno solo: va
    // detto, altrimenti il peso sembra quello complessivo.
    if (holders.length > 1) {
      extraGaps.push(
        `il titolo è movimentato in ${holders.length} portafogli: posizione e peso sono quelli di "${portfolio.name}"`
      );
    }
  } catch (e) {
    // Nessun portafoglio, o un ledger che non si valorizza: l'analisi dello
    // strumento resta valida, perde solo il pezzo "cosa farne nel mio portafoglio".
    logger.warn(
      { instrumentId: inst.id, err: errMessage(e).slice(0, 200) },
      "[analysis] posizione non calcolata: l'analisi continua senza"
    );
  }

  let couponSchedule: AnalysisContext["couponSchedule"] = null;
  let currentYield: string | null = null;
  const q = quotes.get(inst.id);
  if (inst.assetClass === "BOND" && inst.maturityDate) {
    try {
      couponSchedule = bonds
        .couponSchedule(inst)
        .filter((c) => c.payDate >= at)
        .slice(0, SCHEDULE_ROWS)
        .map((c) => ({ payDate: c.payDate, amountPer100: c.amountPer100, irregular: c.irregular }));
      if (q?.price) currentYield = bonds.currentYield(inst, q.price);
    } catch (e) {
      logger.warn(
        { instrumentId: inst.id, err: errMessage(e).slice(0, 200) },
        "[analysis] scadenzario non generabile"
      );
    }
  }

  const context: AnalysisContext = {
    generatedAt: new Date().toISOString(),
    baseCcy: config.market.fxBase,
    instrument: {
      id: inst.id,
      name: inst.name,
      assetClass: inst.assetClass,
      ticker: inst.ticker,
      isin: inst.isin,
      exchange: inst.exchange,
      currency: inst.currency,
      priceSource: inst.priceSource,
      quoteConvention: inst.quoteConvention,
      issuer: inst.issuer,
      notes: inst.notes,
      active: inst.active,
    },
    bond: bondOf(inst),
    couponSchedule,
    currentYield,
    quote: q
      ? {
          price: q.price,
          currency: q.currency,
          previousClose: q.previousClose,
          asOf: q.fetchedAt,
          marketState: q.marketState,
          source: q.source,
        }
      : null,
    priceCoverage: coverage,
    risk: series.length > 0 ? riskMetrics(series, at) : null,
    fundamentals,
    position,
    portfolio,
    portfolioValue,
    provider: provider.name,
  };

  return { ...context, gaps: [...contextGaps(context), ...extraGaps] };
}

/**
 * 20 analisi all'ora per default (`ANALYSIS_RATE_LIMIT`).
 *
 * Non è una difesa dal brute force: è una difesa dalla BOLLETTA. Un doppio click su
 * "Analizza" sono due analisi pagate, e una pagina lasciata aperta con un refresh
 * automatico sarebbero decine.
 */
const analysisLimiter = createLimiter({
  windowMs: 60 * 60 * 1000,
  max: config.limits.analysisPerHour,
  name: "instrument-analysis",
});

/** Un AiError porta già il codice giusto: qui si traduce nella forma d'errore API. */
function rethrow(e: unknown): never {
  if (e instanceof AiError || (e as { name?: string })?.name === "AiError") {
    const ai = e as AiError;
    throw err(ai.code, ai.message, ai.details);
  }
  throw e;
}

const router: FastifyPluginAsync = async (app) => {
  app.get(
    "/:id/analysis",
    {
      preHandler: [
        params(z.object({ id: idParam() })),
        // min(1): `history=0` non significa niente — l'ultima analisi c'è sempre — e
        // un 422 esplicito è meglio di un silenzioso "in realtà te ne dò una".
        query(z.object({ history: z.coerce.number().int().min(1).max(50).optional() })),
      ],
    },
    async (req, reply) => {
      const inst = await instrumentsRepo.byId(req.valid.params.id);
      if (!inst) throw notFound("strumento non trovato");

      // `history` conta le voci TOTALI: `previous` ne avrà una in meno, perché la
      // prima è `latest`.
      const list = await analysesRepo.history(inst.id, req.valid.query.history ?? 5);

      return reply.send({
        instrumentId: inst.id,
        // La UI non deve indovinare perché il pulsante è spento: glielo diciamo.
        configured: isConfigured(),
        model: config.ai.model,
        latest: list[0] ? serialize(list[0]) : null,
        previous: list.slice(1).map(serializeBrief),
        disclaimer:
          "Analisi generata da un modello linguistico sui dati in archivio: è un supporto alla decisione, non una raccomandazione di investimento né consulenza finanziaria o fiscale. Verifica sempre i numeri alla fonte.",
      });
    }
  );

  app.post(
    "/:id/analysis",
    { preHandler: [params(z.object({ id: idParam() }))] },
    async (req, reply) => {
      const inst = await instrumentsRepo.byId(req.valid.params.id);
      if (!inst) throw notFound("strumento non trovato");

      // Prima di costruire il contesto: senza chiave non c'è motivo di interrogare
      // il provider e di valorizzare il portafoglio per poi fallire.
      if (!isConfigured()) {
        throw err("ai_unavailable", "l'analisi con Claude non è configurata", {
          hint: "imposta ANTHROPIC_API_KEY dalla pagina Configurazione del progetto",
        });
      }

      // Il limite si consuma QUI e non in un preHandler: un id inesistente (404),
      // un id malformato (422) o la chiave mancante (503) non costano niente, e
      // bruciare per loro una delle 20 analisi/ora punirebbe l'utente per un errore
      // che non gli è costato un centesimo. `hit()` conta e decide, l'hook no.
      const limit = analysisLimiter.hit(req.ip || "unknown");
      if (!limit.allowed) {
        logger.warn(
          { instrumentId: inst.id, count: limit.count, max: config.limits.analysisPerHour },
          "[analysis] limite oraria raggiunto"
        );
        void reply.header("Retry-After", String(limit.retryAfterSec));
        throw err("rate_limited", "troppe analisi in poco tempo, riprova più tardi", {
          retryAfterSec: limit.retryAfterSec,
          max: config.limits.analysisPerHour,
          hint: "ogni analisi è una chiamata a pagamento: il limite protegge la spesa",
        });
      }

      const context = await buildContext(inst);
      logger.info(
        {
          instrumentId: inst.id,
          assetClass: inst.assetClass,
          hasFundamentals: !!context.fundamentals,
          hasPosition: !!context.position,
          gaps: context.gaps.length,
        },
        "[analysis] contesto pronto, chiamo il modello"
      );

      let result;
      try {
        result = await analyzeInstrument(context);
      } catch (e) {
        rethrow(e);
      }

      let saved;
      try {
        saved = await analysesRepo.create({
          instrumentId: inst.id,
          model: result.model,
          effort: result.effort,
          verdict: result.verdict,
          confidence: result.confidence,
          headline: result.headline,
          analysis: result.analysis,
          // Lo snapshot completo, lacune comprese: è ciò che rende il verdetto
          // rileggibile quando i prezzi e il bilancio saranno cambiati. Il cast è
          // dovuto: `context` è una forma dichiarata, la colonna è un JSONB generico.
          context: context as unknown as Record<string, unknown>,
          usage: result.usage,
        });
      } catch (e) {
        // L'analisi è GIÀ STATA PAGATA e a questo punto esiste solo in memoria: se
        // il salvataggio non riesce (pool caduto, vincolo violato) l'unico modo di
        // non buttarla è metterla nei log. Verboso di proposito — è il contenuto
        // completo, non un riassunto.
        logger.error(
          {
            instrumentId: inst.id,
            err: errMessage(e),
            verdict: result.verdict,
            confidence: result.confidence,
            headline: result.headline,
            analysis: result.analysis,
            usage: result.usage,
          },
          "[analysis] analisi generata e PAGATA ma NON salvata: il contenuto è in questo record"
        );
        throw e;
      }
      if (!saved) throw err("internal_error", "analisi generata ma non salvata");

      // 201: la risorsa è stata creata. La UI la mostra subito, non c'è nulla da
      // accodare — a differenza di /refresh, qui il lavoro è già finito.
      return reply.code(201).send({
        instrumentId: inst.id,
        analysis: serialize(saved),
        durationMs: result.durationMs,
      });
    }
  );
};

export { router, buildContext, serialize as _serialize, RISK_YEARS, analysisLimiter as _analysisLimiter };
