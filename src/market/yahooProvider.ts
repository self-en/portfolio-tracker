// Provider Yahoo Finance.
//
// `market/` non importa mai `domain/`: normalizza i payload del provider e li passa
// a `repo/`. Per questo il numero→stringa ha un helper locale invece di usare
// decimal.js (docs/decisions.md §7).
import logger from "../logger";
import { tolerant } from "./tolerant";

// Verificato in Fase 0: il modulo è dual-published e l'entry CJS fa
// `exports.default = YahooFinance`. Nessuna migrazione ESM necessaria.
import { default as YahooFinance } from "yahoo-finance2";
import { errMessage } from "../util/err";
import type { DateString } from "../types";

// I payload del provider sono JSON esterno: nessuna garanzia di forma, e la forma
// CAMBIA (le note "verificato in Fase 0" qui sopra esistono per questo). Il tipo
// permissivo in ingresso e' onesto; sono i normalizzatori a produrre le forme
// strette qui sotto, che e' esattamente cio' che il resto dell'app consuma.
type RawPayload = any;

export interface NormalizedQuote {
  symbol: string;
  price: string;
  currency: string | null;
  previousClose: string | null;
  marketState: string | null;
  quoteTime: string | null;
}

export interface NormalizedBar {
  date: DateString;
  open: string | null;
  high: string | null;
  low: string | null;
  close: string;
  adjClose: string | null;
  volume: string | null;
}

export interface NormalizedEvents {
  dividends: Array<{ exDate: DateString; amount: string }>;
  splits: Array<{ date: DateString; ratio: string }>;
}

export interface NormalizedSearchHit {
  symbol: string;
  name: string;
  exchange: string | null;
  quoteType: string | null;
  currency: string | null;
  score: string | null;
}

export interface UpcomingDividend {
  exDate: DateString | null;
  payDate: DateString | null;
  amountPerUnit: string | null;
}

/**
 * Adapter pino per il logger della libreria.
 *
 * OBBLIGATORIO: il logger di DEFAULT di yahoo-finance2 è `console.log/warn/error/dir`,
 * che su questa piattaforma NON viene inoltrato via OTLP — quindi il default è una
 * violazione silenziosa della regola sui log (docs/decisions.md §10).
 *
 * Deve fornire tutti e cinque `info/warn/error/debug/dir`: la libreria li valida in
 * costruzione e uno mancante fa fallire il `new`.
 */
const pinoAdapter = {
  info: (...args: unknown[]) => logger.info({ yf: args.map(brief) }, "[yahoo] info"),
  warn: (...args: unknown[]) => logger.warn({ yf: args.map(brief) }, "[yahoo] warn"),
  error: (...args: unknown[]) => logger.error({ yf: args.map(brief) }, "[yahoo] error"),
  debug: (...args: unknown[]) => logger.debug({ yf: args.map(brief) }, "[yahoo] debug"),
  // `dir` è quello che si dimentica: la libreria lo usa per gli oggetti.
  dir: (...args: unknown[]) => logger.debug({ yf: args.map(brief) }, "[yahoo] dir"),
};

function brief(v: unknown): string {
  if (typeof v === "string") return v.slice(0, 500);
  try {
    return JSON.stringify(v).slice(0, 500);
  } catch {
    return String(v).slice(0, 500);
  }
}

/** Numero → stringa, senza notazione esponenziale e senza inventare precisione. */
function numStr(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  if (n !== 0 && Math.abs(n) < 1e-6) return n.toFixed(15).replace(/0+$/, "");
  return String(n);
}

/** Istante → 'YYYY-MM-DD' usando la parte UTC. */
function dateStr(v: unknown): DateString | null {
  if (!v) return null;
  if (typeof v === "string") {
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
    const m = /^(\d{4}-\d{2}-\d{2})T/.exec(v);
    if (m) return m[1];
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  if (typeof v === "number") {
    // Epoch in secondi o millisecondi: Yahoo usa i secondi negli endpoint grezzi.
    const ms = v < 1e12 ? v * 1000 : v;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }
  return null;
}

function isoStr(v: unknown): string | null {
  if (!v) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (typeof v === "string") {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof v === "number") {
    const d = new Date(v < 1e12 ? v * 1000 : v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

// --- Normalizzatori: funzioni PURE sui payload, testate contro le fixture ---

function normalizeQuote(q: RawPayload): NormalizedQuote | null {
  if (!q || !q.symbol) return null;
  const price = numStr(q.regularMarketPrice);
  if (price === null) return null; // una quotazione senza prezzo non è una quotazione
  return {
    symbol: q.symbol,
    price,
    currency: q.currency || null,
    previousClose: numStr(q.regularMarketPreviousClose),
    marketState: q.marketState || null,
    quoteTime: isoStr(q.regularMarketTime),
  };
}

/**
 * Barre di `chart`.
 *
 * NOTA DALLA FIXTURE: il campo è `adjclose` (c minuscola), non `adjClose`. Si
 * accettano entrambe le forme, perché è esattamente il genere di dettaglio che il
 * drift cambia.
 */
function normalizeBars(chart: RawPayload): NormalizedBar[] {
  const raw: RawPayload[] = Array.isArray(chart?.quotes) ? chart.quotes : [];
  const bars: NormalizedBar[] = [];
  for (const b of raw) {
    const date = dateStr(b.date);
    const close = numStr(b.close);
    // Una barra senza data o senza chiusura non è utilizzabile: Yahoo ne
    // restituisce di semivuote sui giorni di festività.
    if (!date || close === null) continue;
    bars.push({
      date,
      open: numStr(b.open),
      high: numStr(b.high),
      low: numStr(b.low),
      close,
      adjClose: numStr(b.adjclose ?? b.adjClose),
      volume: numStr(b.volume),
    });
  }
  // Deduplica per data mantenendo l'ultima: su intervalli intraday Yahoo può
  // restituire più righe per lo stesso giorno.
  const byDate = new Map<DateString, NormalizedBar>();
  for (const b of bars) byDate.set(b.date, b);
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/**
 * Dividendi e split da `chart({ events: "div|split" })`.
 *
 * NOTA DALLA FIXTURE: `events` è `[]` (array vuoto) quando non ci sono eventi, e
 * `{dividends, splits}` altrimenti. Gli split portano
 * `{numerator, denominator, splitRatio: "4:1"}` → ratio = numerator/denominator.
 */
function normalizeEvents(chart: RawPayload): NormalizedEvents {
  const ev = chart?.events;
  const out: NormalizedEvents = { dividends: [], splits: [] };
  if (!ev || Array.isArray(ev)) return out; // [] = nessun evento

  const divs = Array.isArray(ev.dividends) ? ev.dividends : Object.values(ev.dividends || {});
  for (const d of divs) {
    const exDate = dateStr(d?.date);
    const amount = numStr(d?.amount);
    if (exDate && amount !== null) out.dividends.push({ exDate, amount });
  }

  const splits = Array.isArray(ev.splits) ? ev.splits : Object.values(ev.splits || {});
  for (const s of splits) {
    const date = dateStr(s?.date);
    if (!date) continue;
    let ratio: string | null = null;
    if (Number.isFinite(s?.numerator) && Number.isFinite(s?.denominator) && s.denominator !== 0) {
      ratio = numStr(s.numerator / s.denominator);
    } else if (typeof s?.splitRatio === "string" && s.splitRatio.includes(":")) {
      // Fallback sulla stringa "4:1" se i numerici sono cambiati forma.
      const [n, d2] = s.splitRatio.split(":").map(Number);
      if (Number.isFinite(n) && Number.isFinite(d2) && d2 !== 0) ratio = numStr(n / d2);
    }
    if (ratio !== null) out.splits.push({ date, ratio });
  }

  out.dividends.sort((a, b) => (a.exDate < b.exDate ? -1 : 1));
  out.splits.sort((a, b) => (a.date < b.date ? -1 : 1));
  return out;
}

function normalizeSearch(result: RawPayload): NormalizedSearchHit[] {
  const quotes: RawPayload[] = Array.isArray(result?.quotes) ? result.quotes : [];
  return quotes
    .filter((q: RawPayload) => q && q.symbol && q.isYahooFinance !== false)
    .map((q: RawPayload) => ({
      symbol: q.symbol,
      name: q.longname || q.shortname || q.symbol,
      exchange: q.exchDisp || q.exchange || null,
      quoteType: q.quoteType || null,
      // La fixture di Fase 0 mostra che `search` NON restituisce la valuta:
      // va risolta dopo, con una quote.
      currency: q.currency || null,
      score: numStr(q.score),
    }));
}

/** `quoteSummary` OMETTE i moduli assenti: mai assumere che ci siano (verificato). */
function normalizeUpcomingDividend(summary: RawPayload): UpcomingDividend | null {
  const cal = summary?.calendarEvents;
  if (!cal) return null;
  const exDate = dateStr(cal.exDividendDate);
  const payDate = dateStr(cal.dividendDate);
  if (!exDate && !payDate) return null;
  const amountPerUnit = numStr(summary?.summaryDetail?.dividendRate);
  return { exDate, payDate: payDate || exDate, amountPerUnit };
}

// --- Backoff + circuit breaker ---

const BACKOFF_MS = [1000, 4000, 16000];
const BREAKER_THRESHOLD = 3;
const BREAKER_COOLDOWN_MS = 15 * 60 * 1000;

class CircuitBreaker {
  readonly threshold: number;
  readonly cooldownMs: number;
  failures: number;
  openedAt: number | null;

  constructor({ threshold = BREAKER_THRESHOLD, cooldownMs = BREAKER_COOLDOWN_MS }: { threshold?: number; cooldownMs?: number } = {}) {
    this.threshold = threshold;
    this.cooldownMs = cooldownMs;
    this.failures = 0;
    this.openedAt = null;
  }

  get open() {
    if (this.openedAt === null) return false;
    if (Date.now() - this.openedAt >= this.cooldownMs) {
      // Cooldown scaduto: si riprova (half-open).
      this.openedAt = null;
      this.failures = 0;
      return false;
    }
    return true;
  }

  recordSuccess() {
    this.failures = 0;
    this.openedAt = null;
  }

  recordFailure() {
    this.failures += 1;
    if (this.failures >= this.threshold && this.openedAt === null) {
      this.openedAt = Date.now();
      logger.error(
        { failures: this.failures, cooldownMinutes: Math.round(this.cooldownMs / 60000) },
        "[market] circuit breaker APERTO: si serve solo la cache"
      );
    }
  }

  get status() {
    return {
      open: this.open,
      failures: this.failures,
      openedAt: this.openedAt ? new Date(this.openedAt).toISOString() : null,
    };
  }
}

class UpstreamUnavailable extends Error {
  readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = "UpstreamUnavailable";
    this.code = "upstream_error";
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Un 429/503 è ritentabile; un 404 su un simbolo inesistente non lo è. */
function isRetryable(err: unknown): boolean {
  const msg = String(errMessage(err) || "");
  if (/429|too many requests|rate limit/i.test(msg)) return true;
  if (/50[0234]|timeout|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(msg)) return true;
  return false;
}

/** Rispetta `Retry-After` quando l'errore lo porta. */
function retryAfterMs(err: any): number | null {
  const h = err?.response?.headers?.get?.("retry-after") ?? err?.retryAfter;
  if (!h) return null;
  const secs = Number(h);
  return Number.isFinite(secs) ? Math.min(secs * 1000, 60_000) : null;
}

function createYahooProvider(cfg?: unknown) {
  const yf = new YahooFinance({
    // concurrency 2 / interval 250ms: l'IP di egress del cluster è CONDIVISO, quindi
    // conviene essere conservativi per non guadagnarsi un blocco.
    queue: { concurrency: 2, interval: 250 },
    validation: {
      // logErrors: false — il drift lo gestisce tolerant(), che logga una volta con
      // contesto utile invece di riversare l'intero payload.
      logErrors: false,
      logOptionsErrors: true,
      allowAdditionalProps: true,
    },
    // Il DEFAULT è true e fa una chiamata di rete al boot: inaccettabile.
    versionCheck: false,
    logger: pinoAdapter,
    suppressNotices: ["yahooSurvey"],
  });

  const breaker = new CircuitBreaker();

  /** Esegue con backoff esponenziale + jitter, sotto circuit breaker. */
  async function call<T>(label: string, fn: () => Promise<T>): Promise<T> {
    if (breaker.open) {
      throw new UpstreamUnavailable(
        `provider di mercato non disponibile (circuit breaker aperto): ${label}`
      );
    }

    let lastErr;
    for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt++) {
      try {
        const out = await tolerant(label, fn);
        breaker.recordSuccess();
        return out;
      } catch (err) {
        lastErr = err;
        if (!isRetryable(err) || attempt === BACKOFF_MS.length) break;
        // Jitter: senza, N strumenti che falliscono insieme ritentano insieme.
        const base = retryAfterMs(err) ?? BACKOFF_MS[attempt];
        const wait = base + Math.floor(Math.random() * 250);
        logger.warn(
          { label, attempt: attempt + 1, waitMs: wait, err: String(errMessage(err)).slice(0, 200) },
          "[market] chiamata al provider fallita, riprovo"
        );
        await sleep(wait);
      }
    }

    breaker.recordFailure();
    throw lastErr;
  }

  return {
    name: "yahoo",
    breaker,

    /**
     * Quotazioni. Usa `quoteCombine`, che con i default verificati
     * (maxSymbolsPerRequest: 100, debounceTime: 50) COLLASSA le chiamate in loop in
     * UNA sola richiesta HTTP — verificato in Fase 0 su tre simboli.
     */
    async getQuotes(symbols: ReadonlyArray<string | null | undefined>): Promise<NormalizedQuote[]> {
      const list = [...new Set((symbols || []).filter((s): s is string => !!s))];
      if (list.length === 0) return [];

      const settled = await Promise.allSettled(
        list.map((s) => call(`quoteCombine ${s}`, () => yf.quoteCombine(s)))
      );

      const out: NormalizedQuote[] = [];
      for (let i = 0; i < settled.length; i++) {
        const r = settled[i];
        if (r.status !== "fulfilled") {
          // Un simbolo che fallisce non deve invalidare gli altri 40.
          logger.warn(
            { symbol: list[i], err: errMessage(r.reason).slice(0, 200) },
            "[market] quotazione non recuperata"
          );
          continue;
        }
        const q = normalizeQuote(r.value as RawPayload);
        if (q) out.push(q);
      }
      return out;
    },

    async getHistory(symbol: string, from: DateString, to: DateString) {
      const chart: RawPayload = await call(`chart ${symbol}`, () =>
        yf.chart(symbol, {
          period1: from,
          period2: to,
          interval: "1d",
          events: "div|split",
          return: "array",
        })
      );
      return {
        currency: chart?.meta?.currency || null,
        exchangeName: chart?.meta?.fullExchangeName || chart?.meta?.exchangeName || null,
        longName: chart?.meta?.longName || chart?.meta?.shortName || null,
        bars: normalizeBars(chart),
        events: normalizeEvents(chart),
      };
    },

    async getCorporateActions(symbol: string, from: DateString, to: DateString): Promise<NormalizedEvents> {
      const chart: RawPayload = await call(`chart-events ${symbol}`, () =>
        yf.chart(symbol, {
          period1: from,
          period2: to,
          interval: "1d",
          events: "div|split",
          return: "array",
        })
      );
      return normalizeEvents(chart);
    },

    async getUpcomingDividend(symbol: string): Promise<UpcomingDividend | null> {
      const summary: RawPayload = await call(`quoteSummary ${symbol}`, () =>
        yf.quoteSummary(symbol, { modules: ["calendarEvents", "summaryDetail"] })
      );
      return normalizeUpcomingDividend(summary);
    },

    async resolveSymbol(query: string): Promise<NormalizedSearchHit[]> {
      const result: RawPayload = await call(`search ${query}`, () => yf.search(query));
      return normalizeSearch(result);
    },
  };
}

export {
  createYahooProvider,
  pinoAdapter,
  // Esportati per i test contro le fixture di Fase 0: sono funzioni pure.
  normalizeQuote,
  normalizeBars,
  normalizeEvents,
  normalizeSearch,
  normalizeUpcomingDividend,
  numStr,
  dateStr,
  isoStr,
  CircuitBreaker,
  UpstreamUnavailable,
  isRetryable,
};
