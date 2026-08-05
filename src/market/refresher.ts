// Orchestrazione dei refresh: coda FIFO in memoria a concorrenza 1.
//
// REGOLA FERREA: gli handler HTTP non chiamano mai un provider in modo sincrono.
// Esattamente due eccezioni, entrambe azioni utente esplicite:
//   GET /api/market/search (con debounce client e LRU)
//   POST /api/market/refresh (rate-limit 1/min)
// Tutto il resto passa da qui.
//
// Niente Redis, niente BullMQ. L'accodamento at-most-once in memoria è accettabile
// GRAZIE al reconciler al boot, che trova gli strumenti la cui copertura prezzi non
// arriva a ieri e li riaccoda — e i pod ripartono a ogni push, quindi gira spesso.
import logger from "../logger";
import config from "../config";
import * as instrumentsRepo from "../repo/instruments";
import * as pricesRepo from "../repo/prices";
import * as fxRepo from "../repo/fx";
import * as eventsRepo from "../repo/events";
import * as txRepo from "../repo/transactions";
import * as refreshLog from "../repo/refreshLog";
import { createProvider } from "./provider";
import { createFxProvider } from "./fxProvider";
import { errMessage } from "../util/err";
import type { DateString } from "../types";

/** Un job in coda. `kind` decide quale funzione lo esegue (vedi runJob). */
export interface RefreshJob {
  kind: string;
  /** Rifa' il backfill anche se la copertura sembra completa. */
  force?: boolean;
  id?: string;
  instrumentId?: number;
  from?: DateString;
  quotes?: string[];
}

const queue: RefreshJob[] = [];
let running = false;
let jobSeq = 0;
const stats: { enqueued: number; done: number; failed: number; lastError: string | null } = {
  enqueued: 0,
  done: 0,
  failed: 0,
  lastError: null,
};

/** 'YYYY-MM-DD' di oggi in UTC. Il tempo entra nel sistema QUI, non in domain/. */
const today = (): DateString => new Date().toISOString().slice(0, 10);
const daysAgo = (n: number): DateString => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

function enqueue(job: RefreshJob): string {
  jobSeq += 1;
  const id = `${job.kind}-${jobSeq}`;
  // Deduplica: riaccodare lo stesso strumento due volte è spreco puro.
  const dup = queue.find((j) => j.kind === job.kind && j.instrumentId === job.instrumentId);
  if (dup) {
    logger.debug({ kind: job.kind, instrumentId: job.instrumentId }, "[refresher] job già in coda");
    return dup.id as string;
  }
  queue.push({ ...job, id });
  stats.enqueued += 1;
  void drain();
  return id;
}

async function drain() {
  if (running) return;
  running = true;
  try {
    while (queue.length > 0) {
      const job = queue.shift() as RefreshJob;
      try {
        await runJob(job);
        stats.done += 1;
      } catch (err) {
        stats.failed += 1;
        stats.lastError = String(errMessage(err)).slice(0, 300);
        // Un job che fallisce non deve fermare la coda.
        logger.error(
          { job: job.kind, instrumentId: job.instrumentId, err: stats.lastError },
          "[refresher] job fallito"
        );
      }
    }
  } finally {
    running = false;
  }
}

async function runJob(job: RefreshJob): Promise<void> {
  switch (job.kind) {
    case "backfill":
      return backfillInstrument(job.instrumentId as number, job);
    case "quotes":
      return refreshQuotes();
    case "history":
      return refreshDailyCloses();
    case "fx":
      return refreshFx(job);
    case "events":
      return refreshUpcomingEvents();
    default:
      throw new Error(`tipo di job sconosciuto: ${job.kind}`);
  }
}

// --- Job ---

/**
 * Backfill dello storico di uno strumento: barre, dividendi, split, copertura FX.
 *
 * Si estende all'indietro fino alla prima transazione, perché una serie che parte
 * dopo il primo acquisto produce un buco proprio all'inizio del grafico.
 */
async function backfillInstrument(instrumentId: number, opts: { from?: DateString } = {}): Promise<void> {
  const inst = await instrumentsRepo.byId(instrumentId);
  if (!inst) return;
  if (inst.priceSource === "manual" || !inst.ticker) {
    // Le obbligazioni non hanno copertura di mercato (verificato in Fase 0): non è
    // un errore, è il caso normale.
    logger.info(
      { instrumentId, priceSource: inst.priceSource },
      "[refresher] strumento a prezzo manuale: backfill saltato"
    );
    return;
  }

  const logId = await refreshLog.start("history", inst.ticker);
  try {
    const earliestTx = await txRepo.earliestDateByInstrument(instrumentId);
    const coverage = await instrumentsRepo.priceCoverage(instrumentId);
    const from =
      opts.from ||
      earliestTx ||
      coverage.from ||
      daysAgo(365 * (config.market.backfillYears || 2));

    const provider = createProvider();
    const history = await provider.getHistory(inst.ticker as string, from, today());

    const rowCount = await pricesRepo.upsertBars(instrumentId, history.bars, "yahoo");

    // Dividendi storici come income_events PAID: alimentano il calendario a
    // ritroso e permettono di riconciliare cosa è stato incassato.
    const events = [];
    for (const d of (history.events ?? { dividends: [], splits: [] }).dividends) {
      events.push({
        instrumentId,
        kind: "DIVIDEND",
        status: "PAID",
        exDate: d.exDate,
        payDate: d.exDate, // Yahoo dà solo l'ex-date sullo storico
        amountPerUnit: d.amount,
        currency: history.currency || inst.currency,
        source: "yahoo",
      });
    }
    for (const s of (history.events ?? { dividends: [], splits: [] }).splits) {
      events.push({
        instrumentId,
        kind: "SPLIT",
        status: "PAID",
        exDate: s.date,
        payDate: s.date,
        splitRatio: s.ratio,
        currency: inst.currency,
        source: "yahoo",
      });
    }
    if (events.length) await eventsRepo.upsertMany(events);

    // La valuta reale dello strumento può differire da quella inserita a mano.
    if (history.currency && history.currency !== inst.currency) {
      logger.warn(
        { instrumentId, dichiarata: inst.currency, effettiva: history.currency },
        "[refresher] la valuta del provider non coincide con quella dello strumento"
      );
    }

    // Copertura FX per la valuta dello strumento, sullo stesso intervallo.
    const ccy = history.currency || inst.currency;
    if (ccy && ccy !== "EUR") await refreshFx({ quotes: [ccy], from });

    await refreshLog.finish(logId, { ok: true, rowCount });
    logger.info(
      { instrumentId, ticker: inst.ticker, bars: rowCount, from, events: events.length },
      "[refresher] backfill completato"
    );
  } catch (err) {
    await refreshLog.finish(logId, { ok: false, error: errMessage(err) });
    throw err;
  }
}

/** Quotazioni di tutto il portafoglio. `quoteCombine` le collassa in una richiesta. */
async function refreshQuotes() {
  const logId = await refreshLog.start("quotes", "tutti");
  try {
    const list = await instrumentsRepo.refreshable();
    if (list.length === 0) {
      await refreshLog.finish(logId, { ok: true, rowCount: 0 });
      return;
    }
    const provider = createProvider();
    const bySymbol = new Map(list.map((i) => [i.ticker, i]));
    const quotes = await provider.getQuotes([...bySymbol.keys()]);

    let n = 0;
    for (const q of quotes) {
      const inst = bySymbol.get(q.symbol);
      if (!inst) continue;
      await pricesRepo.upsertQuote({
        instrumentId: inst.id,
        price: q.price,
        currency: q.currency || inst.currency,
        previousClose: q.previousClose,
        marketState: q.marketState,
        quoteTime: q.quoteTime,
        source: "yahoo",
      });
      n += 1;
    }
    await refreshLog.finish(logId, { ok: true, rowCount: n });
    logger.info({ requested: bySymbol.size, updated: n }, "[refresher] quotazioni aggiornate");
  } catch (err) {
    await refreshLog.finish(logId, { ok: false, error: errMessage(err) });
    throw err;
  }
}

/**
 * Chiusure giornaliere. Finestra corta (10 giorni) invece dell'intero storico: le
 * barre vecchie non cambiano, tranne quando c'è uno split — e quel caso è gestito
 * dalla riconciliazione, che ri-scarica tutto.
 */
async function refreshDailyCloses() {
  const logId = await refreshLog.start("history", "chiusure");
  try {
    const list = await instrumentsRepo.refreshable();
    const provider = createProvider();
    const from = daysAgo(10);
    let total = 0;
    const newSplits = [];

    for (const inst of list) {
      try {
        const history = await provider.getHistory(inst.ticker as string, from, today());
        total += await pricesRepo.upsertBars(inst.id, history.bars, "yahoo");

        // UNO SPLIT NUOVO invalida la serie in cache: il `close` di Yahoo è
        // retro-aggiustato, quindi le barre già salvate sono su una scala diversa da
        // quelle nuove. Si ri-scarica l'intero storico (docs/decisions.md §4).
        for (const s of (history.events ?? { dividends: [], splits: [] }).splits) {
          await eventsRepo.upsert({
            instrumentId: inst.id,
            kind: "SPLIT",
            status: "PAID",
            exDate: s.date,
            payDate: s.date,
            splitRatio: s.ratio,
            currency: inst.currency,
            source: "yahoo",
          });
          newSplits.push({ instrumentId: inst.id, date: s.date, ratio: s.ratio });
        }
      } catch (err) {
        logger.warn(
          { instrumentId: inst.id, ticker: inst.ticker, err: String(errMessage(err)).slice(0, 200) },
          "[refresher] chiusure non recuperate per questo strumento"
        );
      }
    }

    for (const s of newSplits) {
      logger.warn(
        s,
        "[refresher] split rilevato: ri-scarico l'intero storico per mantenere la serie coerente"
      );
      await pricesRepo.deleteAll(s.instrumentId);
      enqueue({ kind: "backfill", instrumentId: s.instrumentId });
    }

    await refreshLog.finish(logId, { ok: true, rowCount: total });
    logger.info({ instruments: list.length, bars: total }, "[refresher] chiusure aggiornate");
  } catch (err) {
    await refreshLog.finish(logId, { ok: false, error: errMessage(err) });
    throw err;
  }
}

async function refreshFx(opts: { quotes?: string[]; from?: DateString } = {}) {
  const logId = await refreshLog.start("fx", (opts.quotes || []).join(",") || "in-uso");
  try {
    let quotes = opts.quotes;
    if (!quotes || quotes.length === 0) {
      quotes = (await instrumentsRepo.currenciesInUse()).filter((c) => c && c !== "EUR");
    }
    if (quotes.length === 0) {
      await refreshLog.finish(logId, { ok: true, rowCount: 0 });
      return;
    }

    // Da dove partire: se non c'è copertura, dalla prima transazione in assoluto.
    let from = opts.from;
    if (!from) {
      const cov = await fxRepo.coverage();
      const covered = new Map(cov.map((c) => [c.currency, c.to]));
      const missing = quotes.filter((q) => !covered.get(q));
      from = missing.length > 0 ? (await txRepo.earliestDate(null)) || daysAgo(730) : daysAgo(10);
    }

    const fxProvider = createFxProvider();
    const { records, source } = await fxProvider.getRates(quotes, { from, to: today() });
    const n = await fxRepo.upsertRates(records, source === "ecb" ? "ecb" : "frankfurter");

    await refreshLog.finish(logId, { ok: true, rowCount: n });
    logger.info({ quotes, from, records: records.length, source }, "[refresher] cambi aggiornati");
  } catch (err) {
    await refreshLog.finish(logId, { ok: false, error: errMessage(err) });
    throw err;
  }
}

/** Ex-date e pay-date dei dividendi imminenti. */
async function refreshUpcomingEvents() {
  const logId = await refreshLog.start("events", "imminenti");
  try {
    const list = await instrumentsRepo.refreshable();
    const provider = createProvider();
    let n = 0;
    for (const inst of list) {
      try {
        const up = await provider.getUpcomingDividend(inst.ticker as string);
        if (!up || !up.payDate) continue;
        await eventsRepo.upsert({
          instrumentId: inst.id,
          kind: "DIVIDEND",
          // ANNOUNCED, non PROJECTED: la data viene dal provider, non da un calcolo.
          status: "ANNOUNCED",
          exDate: up.exDate,
          payDate: up.payDate,
          amountPerUnit: up.amountPerUnit,
          currency: inst.currency,
          source: "yahoo",
        });
        n += 1;
      } catch (err) {
        logger.warn(
          { instrumentId: inst.id, err: String(errMessage(err)).slice(0, 200) },
          "[refresher] dividendi imminenti non recuperati"
        );
      }
    }
    await refreshLog.finish(logId, { ok: true, rowCount: n });
    logger.info({ instruments: list.length, events: n }, "[refresher] eventi imminenti aggiornati");
  } catch (err) {
    await refreshLog.finish(logId, { ok: false, error: errMessage(err) });
    throw err;
  }
}

/**
 * RECONCILER AL BOOT. È ciò che rende accettabile una coda in memoria: trova gli
 * strumenti la cui copertura prezzi non arriva a ieri e li riaccoda.
 *
 * Gira a ogni avvio del pod — cioè a ogni push — quindi un job perso per un
 * riavvio si recupera da solo.
 */
async function reconcile() {
  try {
    const stale = await instrumentsRepo.staleCoverage(daysAgo(1));
    if (stale.length === 0) {
      logger.info("[refresher] reconciler: copertura prezzi allineata");
      return 0;
    }
    for (const s of stale) enqueue({ kind: "backfill", instrumentId: s.id });
    logger.info(
      { count: stale.length, instruments: stale.map((s) => s.ticker) },
      "[refresher] reconciler: strumenti riaccodati per copertura incompleta"
    );
    return stale.length;
  } catch (err) {
    logger.error({ err: errMessage(err) }, "[refresher] reconciler fallito (continuo)");
    return 0;
  }
}

// --- API pubblica ---

const enqueueBackfill = (instrumentId: number, opts: { from?: DateString } = {}): string =>
  enqueue({ kind: "backfill", instrumentId, ...opts });

function enqueueScope(scope: string): string[] {
  switch (scope) {
    case "quotes":
      return [enqueue({ kind: "quotes" })];
    case "history":
      return [enqueue({ kind: "history" })];
    case "fx":
      return [enqueue({ kind: "fx" })];
    case "events":
      return [enqueue({ kind: "events" })];
    case "all": {
      const ids = [
        enqueue({ kind: "quotes" }),
        enqueue({ kind: "fx" }),
        enqueue({ kind: "history" }),
        enqueue({ kind: "events" }),
      ];
      return ids;
    }
    default:
      throw new Error(`scope non valido: ${scope}`);
  }
}

const status = () => ({
  queued: queue.length,
  running,
  ...stats,
  breaker: (() => {
    try {
      // Il breaker esiste solo sul provider Yahoo: il manuale non ha upstream da
  // proteggere, e null e' la risposta onesta.
  return (createProvider() as { breaker?: { status: unknown } }).breaker?.status ?? null;
    } catch {
      return null;
    }
  })(),
});

export { enqueue, enqueueBackfill, enqueueScope, reconcile, status, refreshQuotes, refreshDailyCloses, refreshFx, refreshUpcomingEvents, backfillInstrument, today, daysAgo, queue as _queue };
