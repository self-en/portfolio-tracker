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
 * I fondamentali per l'analisi di bilancio. Tutti i numerici sono STRINGHE e ogni
 * campo è nullable: `quoteSummary` omette i moduli assenti e riempie di `null` i
 * campi che non ha (verificato — vedi la nota su `normalizeFundamentals`).
 *
 * `modules` non è decorativo: è l'elenco dei moduli che Yahoo ha DAVVERO
 * restituito, e diventa l'elenco dei dati mancanti mostrato all'utente. Un'analisi
 * che non dichiara su cosa NON ha potuto lavorare è peggiore di nessuna analisi.
 */
export interface NormalizedFundamentals {
  symbol: string;
  /** Valuta del BILANCIO (`financialCurrency`): può differire da quella di quotazione. */
  currency: string | null;
  /** Fine del trimestre più recente incorporato nei dati. */
  asOf: DateString | null;
  modules: string[];
  profile: {
    sector: string | null;
    industry: string | null;
    country: string | null;
    employees: string | null;
    website: string | null;
    summary: string | null;
  } | null;
  valuation: {
    marketCap: string | null;
    enterpriseValue: string | null;
    trailingPe: string | null;
    forwardPe: string | null;
    priceToBook: string | null;
    priceToSales: string | null;
    enterpriseToRevenue: string | null;
    enterpriseToEbitda: string | null;
    pegRatio: string | null;
    bookValue: string | null;
    trailingEps: string | null;
    forwardEps: string | null;
    beta: string | null;
  };
  profitability: {
    grossMargins: string | null;
    operatingMargins: string | null;
    ebitdaMargins: string | null;
    profitMargins: string | null;
    returnOnEquity: string | null;
    returnOnAssets: string | null;
    revenueGrowth: string | null;
    earningsGrowth: string | null;
  };
  balance: {
    totalRevenue: string | null;
    grossProfits: string | null;
    ebitda: string | null;
    netIncomeToCommon: string | null;
    totalCash: string | null;
    totalCashPerShare: string | null;
    totalDebt: string | null;
    debtToEquity: string | null;
    currentRatio: string | null;
    quickRatio: string | null;
    freeCashflow: string | null;
    operatingCashflow: string | null;
    sharesOutstanding: string | null;
  };
  dividend: {
    rate: string | null;
    yield: string | null;
    payoutRatio: string | null;
    fiveYearAvgYield: string | null;
    exDate: DateString | null;
    lastValue: string | null;
    lastDate: DateString | null;
  };
  /** Ricavi/utili/margine per esercizio: il TREND, che è il dato più utile di tutto il blocco. */
  yearly: Array<{ year: string; revenue: string | null; earnings: string | null; profitMargin: string | null }>;
  /** `incomeStatementHistory`: spesso parziale (vedi la nota), quindi si tiene solo ciò che porta valore. */
  statements: Array<{
    endDate: DateString | null;
    totalRevenue: string | null;
    grossProfit: string | null;
    operatingIncome: string | null;
    netIncome: string | null;
  }>;
  analysts: {
    recommendationKey: string | null;
    recommendationMean: string | null;
    opinions: string | null;
    targetLow: string | null;
    targetMean: string | null;
    targetHigh: string | null;
    trend: Array<{ period: string; strongBuy: number; buy: number; hold: number; sell: number; strongSell: number }>;
  };
  /** Presente solo per fondi ed ETF: costi, replica, composizione. */
  fund: {
    family: string | null;
    legalType: string | null;
    expenseRatio: string | null;
    turnover: string | null;
    totalNetAssets: string | null;
    inceptionDate: DateString | null;
    stockPosition: string | null;
    bondPosition: string | null;
    cashPosition: string | null;
    topHoldings: Array<{ symbol: string | null; name: string | null; weight: string | null }>;
    sectorWeightings: Array<{ sector: string; weight: string | null }>;
  } | null;
  range52w: {
    low: string | null;
    high: string | null;
    fiftyDayAverage: string | null;
    twoHundredDayAverage: string | null;
    change52w: string | null;
  };
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

/**
 * Come `numStr`, ma lo ZERO diventa `null`.
 *
 * Serve SOLO alle voci del conto economico, e non è pignoleria: nella fixture reale
 * AAPL riporta `grossProfit: 0` e `totalOperatingExpenses: 0` su un esercizio da 416
 * miliardi di ricavi. Quello zero è il segnaposto di Yahoo per "non pubblicato", e
 * passarlo a un modello significherebbe dirgli che il margine lordo è zero — un dato
 * sbagliato è molto peggio di un dato assente (docs/decisions.md §5).
 *
 * Un ricavo o un utile lordo davvero pari a zero è un caso che non esiste in una
 * società quotata; se un giorno esistesse, comparirebbe come lacuna dichiarata.
 */
function absentIfZero(v: unknown): string | null {
  const s = numStr(v);
  if (s === null) return null;
  return Number(s) === 0 ? null : s;
}

/** I moduli di `quoteSummary` che servono all'analisi di bilancio. */
const FUNDAMENTAL_MODULES = [
  "assetProfile",
  "summaryProfile",
  "summaryDetail",
  "defaultKeyStatistics",
  "financialData",
  "incomeStatementHistory",
  "balanceSheetHistory",
  "cashflowStatementHistory",
  "earnings",
  "recommendationTrend",
  "fundProfile",
  "topHoldings",
] as const;

/**
 * Fondamentali da `quoteSummary`.
 *
 * DUE COSE VERIFICATE SUL PAYLOAD REALE (fixture
 * `quoteSummary-fundamentals-AAPL.json`, catturata da Yahoo), che decidono la forma
 * di questa funzione:
 *
 * 1. **`balanceSheetHistory` è VUOTO**: gli statement contengono `endDate` e nulla
 *    più — niente `totalAssets`, niente `totalLiab`, niente patrimonio netto. Anche
 *    `cashflowStatementHistory` porta solo `netIncome`, e in
 *    `incomeStatementHistory` metà delle voci è `null` o `0` (per AAPL:
 *    `grossProfit: 0`, `operatingIncome: null`). Lo stato patrimoniale "vero" da
 *    questa API non esiste più.
 *    Quindi l'analisi di bilancio NON si appoggia agli statement: la sostanza sta in
 *    `financialData` (indebitamento, liquidità, ratio correnti, margini, ROE/ROA,
 *    flussi di cassa) e in `defaultKeyStatistics` (patrimonio per azione, multipli).
 *    Gli statement si tengono comunque, perché ciò che c'è è reale e perché il
 *    giorno in cui Yahoo tornasse a popolarli il codice li mostra senza modifiche.
 * 2. **Su un ETF i moduli aziendali sono ASSENTI, non vuoti** (EUNL.DE non ha
 *    `financialData` né `incomeStatementHistory`): al loro posto arrivano
 *    `fundProfile` (TER!) e `topHoldings`. È il motivo per cui `modules` viaggia
 *    nella risposta.
 */
function normalizeFundamentals(symbol: string, summary: RawPayload): NormalizedFundamentals {
  const fd: RawPayload = summary?.financialData || {};
  const ks: RawPayload = summary?.defaultKeyStatistics || {};
  const sd: RawPayload = summary?.summaryDetail || {};
  const prof: RawPayload = summary?.assetProfile || summary?.summaryProfile || null;
  const fp: RawPayload = summary?.fundProfile || null;
  const th: RawPayload = summary?.topHoldings || null;

  const yearlyRaw: RawPayload[] = Array.isArray(summary?.earnings?.financialsChart?.yearly)
    ? summary.earnings.financialsChart.yearly
    : [];
  const stmtRaw: RawPayload[] = Array.isArray(summary?.incomeStatementHistory?.incomeStatementHistory)
    ? summary.incomeStatementHistory.incomeStatementHistory
    : [];
  const trendRaw: RawPayload[] = Array.isArray(summary?.recommendationTrend?.trend)
    ? summary.recommendationTrend.trend
    : [];

  // Un profilo con solo il telefono NON è un profilo: sull'ETF `assetProfile`
  // esiste ma contiene `{phone, companyOfficers: [], maxAge}`, e riportarlo
  // farebbe credere all'analisi di avere un contesto qualitativo che non ha.
  const hasProfile = !!(prof && (prof.sector || prof.industry || prof.longBusinessSummary));

  const fund = fp || th
    ? {
        family: fp?.family ?? ks.fundFamily ?? null,
        legalType: fp?.legalType ?? ks.legalType ?? null,
        expenseRatio: numStr(fp?.feesExpensesInvestment?.annualReportExpenseRatio),
        turnover: numStr(fp?.feesExpensesInvestment?.annualHoldingsTurnover),
        totalNetAssets: numStr(fp?.feesExpensesInvestment?.totalNetAssets),
        inceptionDate: dateStr(ks.fundInceptionDate),
        stockPosition: numStr(th?.stockPosition),
        bondPosition: numStr(th?.bondPosition),
        cashPosition: numStr(th?.cashPosition),
        topHoldings: (Array.isArray(th?.holdings) ? th.holdings : []).map((h: RawPayload) => ({
          symbol: h?.symbol || null,
          name: h?.holdingName || null,
          weight: numStr(h?.holdingPercent),
        })),
        // `sectorWeightings` è un array di oggetti a UNA chiave
        // (`[{realestate: 0.0169}, {technology: 0.27}]`), non una mappa: verificato.
        sectorWeightings: (Array.isArray(th?.sectorWeightings) ? th.sectorWeightings : []).flatMap(
          (w: RawPayload) =>
            Object.entries(w || {}).map(([sector, weight]) => ({ sector, weight: numStr(weight) }))
        ),
      }
    : null;

  return {
    symbol,
    currency: fd.financialCurrency || summary?.earnings?.financialCurrency || null,
    asOf: dateStr(ks.mostRecentQuarter),
    // Solo i moduli DAVVERO presenti: è la lista da cui la UI ricava i dati mancanti.
    modules: FUNDAMENTAL_MODULES.filter((m) => summary?.[m] !== undefined && summary?.[m] !== null),
    profile: hasProfile
      ? {
          sector: prof.sectorDisp || prof.sector || null,
          industry: prof.industryDisp || prof.industry || null,
          country: prof.country || null,
          employees: numStr(prof.fullTimeEmployees),
          website: prof.website || null,
          // Il riassunto dell'attività è prosa lunga: si tronca, perché entra in un
          // prompt a pagamento e le prime righe portano quasi tutta l'informazione.
          summary: typeof prof.longBusinessSummary === "string" ? prof.longBusinessSummary.slice(0, 1200) : null,
        }
      : null,
    valuation: {
      marketCap: numStr(sd.marketCap),
      enterpriseValue: numStr(ks.enterpriseValue),
      trailingPe: numStr(sd.trailingPE),
      forwardPe: numStr(sd.forwardPE ?? ks.forwardPE),
      priceToBook: numStr(ks.priceToBook),
      priceToSales: numStr(sd.priceToSalesTrailing12Months),
      enterpriseToRevenue: numStr(ks.enterpriseToRevenue),
      enterpriseToEbitda: numStr(ks.enterpriseToEbitda),
      pegRatio: numStr(ks.pegRatio),
      bookValue: numStr(ks.bookValue),
      trailingEps: numStr(ks.trailingEps),
      forwardEps: numStr(ks.forwardEps),
      beta: numStr(sd.beta ?? ks.beta),
    },
    profitability: {
      grossMargins: numStr(fd.grossMargins),
      operatingMargins: numStr(fd.operatingMargins),
      ebitdaMargins: numStr(fd.ebitdaMargins),
      profitMargins: numStr(fd.profitMargins ?? ks.profitMargins),
      returnOnEquity: numStr(fd.returnOnEquity),
      returnOnAssets: numStr(fd.returnOnAssets),
      revenueGrowth: numStr(fd.revenueGrowth),
      earningsGrowth: numStr(fd.earningsGrowth),
    },
    balance: {
      totalRevenue: numStr(fd.totalRevenue),
      grossProfits: numStr(fd.grossProfits),
      ebitda: numStr(fd.ebitda),
      netIncomeToCommon: numStr(ks.netIncomeToCommon),
      totalCash: numStr(fd.totalCash),
      totalCashPerShare: numStr(fd.totalCashPerShare),
      totalDebt: numStr(fd.totalDebt),
      // `debtToEquity` di Yahoo è in PERCENTUALE (78.445 = 78,4%), non un multiplo:
      // passa così com'è e il prompt lo dichiara, invece di dividerlo per 100 qui e
      // dover ricordare a valle che è già stato diviso.
      debtToEquity: numStr(fd.debtToEquity),
      currentRatio: numStr(fd.currentRatio),
      quickRatio: numStr(fd.quickRatio),
      freeCashflow: numStr(fd.freeCashflow),
      operatingCashflow: numStr(fd.operatingCashflow),
      sharesOutstanding: numStr(ks.sharesOutstanding),
    },
    dividend: {
      rate: numStr(sd.dividendRate),
      yield: numStr(sd.dividendYield),
      payoutRatio: numStr(sd.payoutRatio),
      fiveYearAvgYield: numStr(sd.fiveYearAvgDividendYield),
      exDate: dateStr(sd.exDividendDate),
      lastValue: numStr(ks.lastDividendValue),
      lastDate: dateStr(ks.lastDividendDate),
    },
    yearly: yearlyRaw
      .filter((y) => y && y.date !== undefined && y.date !== null)
      .map((y) => ({
        year: String(y.date),
        revenue: numStr(y.revenue),
        earnings: numStr(y.earnings),
        profitMargin: numStr(y.profitMargin),
      })),
    statements: stmtRaw.map((s) => ({
      endDate: dateStr(s?.endDate),
      totalRevenue: absentIfZero(s?.totalRevenue),
      grossProfit: absentIfZero(s?.grossProfit),
      operatingIncome: absentIfZero(s?.operatingIncome),
      netIncome: absentIfZero(s?.netIncome),
    })),
    analysts: {
      recommendationKey: fd.recommendationKey || null,
      recommendationMean: numStr(fd.recommendationMean),
      opinions: numStr(fd.numberOfAnalystOpinions),
      targetLow: numStr(fd.targetLowPrice),
      targetMean: numStr(fd.targetMeanPrice),
      targetHigh: numStr(fd.targetHighPrice),
      trend: trendRaw
        .filter((t) => t && typeof t.period === "string")
        .map((t) => ({
          period: t.period,
          strongBuy: Number(t.strongBuy) || 0,
          buy: Number(t.buy) || 0,
          hold: Number(t.hold) || 0,
          sell: Number(t.sell) || 0,
          strongSell: Number(t.strongSell) || 0,
        })),
    },
    fund,
    range52w: {
      low: numStr(sd.fiftyTwoWeekLow),
      high: numStr(sd.fiftyTwoWeekHigh),
      fiftyDayAverage: numStr(sd.fiftyDayAverage),
      twoHundredDayAverage: numStr(sd.twoHundredDayAverage),
      change52w: numStr(ks["52WeekChange"]),
    },
  };
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

    /**
     * Fondamentali per l'analisi di bilancio. UNA chiamata, molti moduli: Yahoo
     * omette in silenzio quelli che non ha, quindi chiederne dodici e normalizzare
     * ciò che torna costa una richiesta sola invece di dodici tentativi.
     */
    async getFundamentals(symbol: string): Promise<NormalizedFundamentals> {
      const summary: RawPayload = await call(`quoteSummary-fundamentals ${symbol}`, () =>
        yf.quoteSummary(symbol, { modules: [...FUNDAMENTAL_MODULES] as any })
      );
      return normalizeFundamentals(symbol, summary);
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
  normalizeFundamentals,
  FUNDAMENTAL_MODULES,
  numStr,
  absentIfZero,
  dateStr,
  isoStr,
  CircuitBreaker,
  UpstreamUnavailable,
  isRetryable,
};
