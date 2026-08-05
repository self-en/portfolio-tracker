// I normalizzatori del provider contro le fixture REALI catturate in Fase 0.
//
// È questo che rende ogni normalizzatore una funzione pura per sempre: le fixture
// sono risposte vere di Yahoo e Frankfurter, non forme indovinate.
// Per PRIMO: imposta l'env prima che qualsiasi import carichi src/config.
import "../helpers/env";

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import * as yp from "../../src/market/yahooProvider";
import * as fx from "../../src/market/fxProvider";
import { tolerant } from "../../src/market/tolerant";
import { importsOf, readSources } from "../helpers/sourceScan";
import { must } from "../helpers/must";

/**
 * Una fixture catturata da un provider reale. `any` è deliberato: il punto di un
 * normalizzatore è proprio accettare un payload non tipizzato di cui non
 * controlliamo la forma, e dichiararne una qui sarebbe una forma INVENTATA che
 * nasconde ciò che il test deve dimostrare.
 */
const fixture = (rel: string): any =>
  require(path.join(__dirname, "..", "fixtures", rel));

// ---------------------------------------------------------------------------
// Quotazioni
// ---------------------------------------------------------------------------

test("normalizeQuote sulla fixture reale EUNL.DE", () => {
  const q = must(yp.normalizeQuote(fixture("yahoo/quote-EUNL.DE.json")), "la quotazione");
  assert.equal(q.symbol, "EUNL.DE");
  assert.equal(q.price, "127.325");
  assert.equal(q.currency, "EUR");
  assert.equal(q.previousClose, "126.175");
  assert.equal(q.marketState, "REGULAR");
  assert.equal(q.quoteTime, "2026-08-04T14:14:56.000Z");
  // Numerici come STRINGA sul filo.
  assert.equal(typeof q.price, "string");
  assert.equal(typeof q.previousClose, "string");
});

test("normalizeQuote sulla fixture multi-simbolo di quoteCombine", () => {
  const rows = fixture("yahoo/quoteCombine-multi.json").map(yp.normalizeQuote);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r: any) => r.symbol), ["AAPL", "MSFT", "EUNL.DE"]);
  assert.deepEqual(rows.map((r: any) => r.currency), ["USD", "USD", "EUR"]);
  for (const r of rows) assert.equal(typeof r.price, "string");
});

test("normalizeQuote scarta una quotazione SENZA prezzo (non è una quotazione)", () => {
  assert.equal(yp.normalizeQuote({ symbol: "X", currency: "EUR" }), null);
  assert.equal(yp.normalizeQuote({ symbol: "X", regularMarketPrice: null }), null);
  assert.equal(yp.normalizeQuote({ regularMarketPrice: 10 }), null, "senza symbol è inutile");
  assert.equal(yp.normalizeQuote(null), null);
});

// ---------------------------------------------------------------------------
// Barre storiche
// ---------------------------------------------------------------------------

test("normalizeBars legge `adjclose` (c MINUSCOLA), come nella fixture reale", () => {
  // Il dettaglio catturato in Fase 0: il campo NON è `adjClose`. Indovinarlo
  // avrebbe prodotto adjClose: null su tutta la serie, in silenzio.
  const raw = fixture("yahoo/chart-EUNL.DE.json");
  assert.ok("adjclose" in raw.quotes[0], "la fixture deve avere adjclose minuscolo");
  const bars = yp.normalizeBars(raw);
  assert.equal(bars.length, 126);
  assert.ok(bars[0].adjClose !== null, "adjClose deve essere popolato");
  assert.equal(bars[0].date, "2024-01-02");
  assert.equal(bars[0].close, "82.21600341796875");
});

test("normalizeBars accetta anche la forma `adjClose` (tolleranza al drift)", () => {
  const bars = yp.normalizeBars({
    quotes: [{ date: "2026-01-02T08:00:00.000Z", close: 100, adjClose: 99 }],
  });
  assert.equal(bars[0].adjClose, "99");
});

test("normalizeBars converte l'istante di apertura nella data UTC corretta", () => {
  // Xetra apre alle 08:00Z, NYSE alle 13:30Z: in entrambi i casi la parte UTC è la
  // price_date giusta.
  const xetra = yp.normalizeBars(fixture("yahoo/chart-EUNL.DE.json"));
  assert.equal(xetra[0].date, "2024-01-02");
  const nyse = yp.normalizeBars(fixture("yahoo/chart-AAPL-splitdiv.json"));
  assert.equal(nyse[0].date, "2020-06-01");
});

test("normalizeBars scarta le barre senza data o senza chiusura", () => {
  const bars = yp.normalizeBars({
    quotes: [
      { date: "2026-01-02T08:00:00Z", close: 100 },
      { date: "2026-01-03T08:00:00Z", close: null }, // festività
      { date: null, close: 105 },
      { date: "2026-01-06T08:00:00Z", close: 101 },
    ],
  });
  assert.deepEqual(bars.map((b) => b.date), ["2026-01-02", "2026-01-06"]);
});

test("normalizeBars deduplica per data e ordina in modo ASCENDENTE", () => {
  const bars = yp.normalizeBars({
    quotes: [
      { date: "2026-01-06T08:00:00Z", close: 101 },
      { date: "2026-01-02T08:00:00Z", close: 100 },
      { date: "2026-01-06T16:00:00Z", close: 102 }, // stessa data, riga più recente
    ],
  });
  assert.equal(bars.length, 2);
  assert.deepEqual(bars.map((b) => b.date), ["2026-01-02", "2026-01-06"]);
  assert.equal(bars[1].close, "102", "l'ultima riga per quella data vince");
});

test("normalizeBars su un payload vuoto o malformato non lancia", () => {
  assert.deepEqual(yp.normalizeBars(null), []);
  assert.deepEqual(yp.normalizeBars({}), []);
  assert.deepEqual(yp.normalizeBars({ quotes: null }), []);
  assert.deepEqual(yp.normalizeBars({ quotes: "non-un-array" }), []);
});

// ---------------------------------------------------------------------------
// Dividendi e split
// ---------------------------------------------------------------------------

test("normalizeEvents estrae dividendi e split dalla fixture AAPL reale", () => {
  const ev = yp.normalizeEvents(fixture("yahoo/chart-AAPL-splitdiv.json"));
  assert.equal(ev.dividends.length, 3);
  assert.equal(ev.dividends[0].exDate, "2020-08-07");
  assert.equal(ev.dividends[0].amount, "0.205");

  assert.equal(ev.splits.length, 1);
  assert.equal(ev.splits[0].date, "2020-08-31");
  // numerator/denominator = 4/1 → ratio 4.
  assert.equal(ev.splits[0].ratio, "4");
});

test("normalizeEvents gestisce `events` ASSENTE, come nella fixture reale EUNL.DE", () => {
  // Dettaglio verificato sulla fixture: quando non ci sono eventi nel periodo,
  // yahoo-finance2 non restituisce `events` AFFATTO (non un oggetto vuoto, non un
  // array vuoto). Un accesso diretto a `chart.events.dividends` sarebbe un
  // TypeError su ogni strumento senza dividendi nella finestra richiesta.
  const raw = fixture("yahoo/chart-EUNL.DE.json");
  assert.equal(raw.events, undefined, "la fixture non deve avere la chiave events");
  assert.deepEqual(yp.normalizeEvents(raw), { dividends: [], splits: [] });
});

test("normalizeEvents tollera anche `events: []` e `events: {}`", () => {
  // Forme che il drift potrebbe introdurre: costano una riga e non vanno indovinate.
  assert.deepEqual(yp.normalizeEvents({ events: [] }), { dividends: [], splits: [] });
  assert.deepEqual(yp.normalizeEvents({ events: {} }), { dividends: [], splits: [] });
  assert.deepEqual(yp.normalizeEvents({ events: { dividends: [], splits: [] } }), {
    dividends: [],
    splits: [],
  });
});

test("normalizeEvents ricade su splitRatio '4:1' se i numerici cambiano forma", () => {
  const ev = yp.normalizeEvents({
    events: { splits: [{ date: "2020-08-31T13:30:00Z", splitRatio: "4:1" }] },
  });
  assert.equal(ev.splits[0].ratio, "4");
});

test("normalizeEvents gestisce split inversi e ratio non validi", () => {
  const ev = yp.normalizeEvents({
    events: {
      splits: [
        { date: "2026-01-01T00:00:00Z", numerator: 1, denominator: 10 }, // raggruppamento
        { date: "2026-02-01T00:00:00Z", numerator: 1, denominator: 0 }, // divisione per zero
        { date: "2026-03-01T00:00:00Z" }, // nessun ratio
      ],
    },
  });
  assert.equal(ev.splits.length, 1);
  assert.equal(ev.splits[0].ratio, "0.1");
});

test("normalizeEvents accetta anche eventi come mappa indicizzata (forma legacy)", () => {
  const ev = yp.normalizeEvents({
    events: {
      dividends: { 1596801000: { amount: 0.205, date: "2020-08-07T13:30:00Z" } },
      splits: {},
    },
  });
  assert.equal(ev.dividends.length, 1);
  assert.equal(ev.dividends[0].amount, "0.205");
});

// ---------------------------------------------------------------------------
// Ricerca simboli
// ---------------------------------------------------------------------------

test("normalizeSearch risolve ISIN → ticker sulla fixture reale", () => {
  const items = yp.normalizeSearch(fixture("yahoo/search-IE00B4L5Y983.json"));
  assert.ok(items.length >= 1);
  assert.equal(items[0].symbol, "IWDA.L");
  assert.equal(items[0].quoteType, "ETF");
  assert.equal(items[0].exchange, "London");
  assert.equal(items[0].name, "iShares Core MSCI World UCITS ETF USD (Acc)");
  // La fixture dimostra che `search` NON restituisce la valuta.
  assert.equal(items[0].currency, null);
});

test("normalizeSearch su copertura ZERO restituisce lista vuota (i BTP)", () => {
  // Verificato in Fase 0: tre ISIN di BTP → tutti `quotes: []`. Il pricing manuale
  // dei bond non è un fallback, è *la* strada.
  const bonds = fixture("yahoo/search-bonds.json");
  for (const [isin, symbols] of Object.entries(bonds)) {
    assert.deepEqual(symbols, [], `${isin} dovrebbe essere senza copertura`);
    assert.deepEqual(yp.normalizeSearch({ quotes: [] }), []);
  }
});

test("normalizeSearch scarta le voci non-Yahoo e senza simbolo", () => {
  const items = yp.normalizeSearch({
    quotes: [
      { symbol: "OK.MI", isYahooFinance: true },
      { symbol: "NO", isYahooFinance: false },
      { shortname: "senza simbolo" },
      null,
    ],
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].symbol, "OK.MI");
});

// ---------------------------------------------------------------------------
// Dividendi imminenti
// ---------------------------------------------------------------------------

test("normalizeUpcomingDividend legge ex-date e pay-date da calendarEvents", () => {
  const up = must(
    yp.normalizeUpcomingDividend(fixture("yahoo/quoteSummary-AAPL.json")),
    "il dividendo annunciato"
  );
  assert.equal(up.exDate, "2026-08-10");
  assert.equal(up.payDate, "2026-08-13");
});

test("normalizeUpcomingDividend restituisce null quando il MODULO È ASSENTE", () => {
  // quoteSummary OMETTE i moduli assenti: la fixture EUNL.DE non ha calendarEvents
  // pur essendo stato richiesto. Assumere che ci sia produrrebbe un TypeError.
  const raw = fixture("yahoo/quoteSummary-EUNL.DE.json");
  assert.equal("calendarEvents" in raw, false, "la fixture deve mancare del modulo");
  assert.equal(yp.normalizeUpcomingDividend(raw), null);
  assert.equal(yp.normalizeUpcomingDividend(null), null);
  assert.equal(yp.normalizeUpcomingDividend({}), null);
});

// ---------------------------------------------------------------------------
// tolerant(): il percorso err.result
// ---------------------------------------------------------------------------

test("tolerant restituisce err.result quando la validazione zod LANCIA", () => {
  // È il meccanismo che rende il drift di Yahoo sopravvivibile. Si simula una
  // FailedYahooValidationError con il payload coercito, esattamente come la
  // produce yahoo-finance2.
  const drifted = {
    quotes: [{ date: "2026-01-02T08:00:00Z", close: 100, campoNuovoInatteso: true }],
    events: [],
  };
  const boom = () => {
    // La forma REALE dell'errore di yahoo-finance2: un Error con `result` (il
    // payload comunque decodificato) e `errors` (le chiavi inattese) attaccati.
    const e = new Error("validazione fallita") as Error & {
      result?: unknown;
      errors?: string[];
    };
    e.name = "FailedYahooValidationError";
    e.result = drifted;
    e.errors = ["Unexpected key campoNuovoInatteso", "altro problema", "terzo", "quarto"];
    throw e;
  };

  return tolerant("test-drift", boom).then((out) => {
    assert.deepEqual(out, drifted, "il payload coercito deve tornare al chiamante");
    // E il risultato è ancora normalizzabile: il drift degrada a warning, non a
    // dashboard rotta.
    const bars = yp.normalizeBars(out);
    assert.equal(bars.length, 1);
    assert.equal(bars[0].close, "100");
  });
});

test("tolerant RILANCIA gli errori che non sono drift di validazione", async () => {
  await assert.rejects(
    tolerant("test", () => {
      throw new Error("429 Too Many Requests");
    }),
    /429/
  );
  // Una FailedYahooValidationError SENZA result non è recuperabile: va rilanciata.
  await assert.rejects(
    tolerant("test", () => {
      const e = new Error("nessun payload");
      e.name = "FailedYahooValidationError";
      throw e;
    }),
    /nessun payload/
  );
});

test("tolerant lascia passare il caso felice senza toccarlo", async () => {
  const out = await tolerant("ok", async () => ({ a: 1 }));
  assert.deepEqual(out, { a: 1 });
});

// ---------------------------------------------------------------------------
// Frankfurter v2
// ---------------------------------------------------------------------------

test("normalizeFrankfurter legge la forma ARRAY della v2 (fixture reale, data singola)", () => {
  const recs = fx.normalizeFrankfurter(fixture("fx/frankfurter-v2-single.json"));
  assert.equal(recs.length, 3);
  for (const r of recs) {
    assert.equal(r.base, "EUR");
    assert.equal(r.date, "2026-08-04");
    assert.equal(typeof r.rate, "string");
  }
  const usd = must(recs.find((r) => r.quote === "USD"), "il record USD");
  assert.equal(usd.rate, "1.1523");
});

test("normalizeFrankfurter su un RANGE restituisce ogni coppia × ogni data", () => {
  // Verificato in Fase 0: un solo GET copre l'intero backfill storico FX.
  const recs = fx.normalizeFrankfurter(fixture("fx/frankfurter-v2-range.json"));
  const dates = [...new Set(recs.map((r) => r.date))].sort();
  const quotes = [...new Set(recs.map((r) => r.quote))].sort();
  assert.deepEqual(quotes, ["GBP", "USD"]);
  assert.ok(dates.length >= 3, `attese più date, trovate ${dates.length}`);
  assert.equal(recs.length, dates.length * quotes.length);
  assert.equal(dates[0], "2026-07-30");
});

test("normalizeFrankfurter tollera ANCHE la forma a mappa della v1 (piatta e annidata)", () => {
  const piatta = fx.normalizeFrankfurter({
    base: "EUR",
    date: "2026-08-04",
    rates: { USD: 1.1523, GBP: 0.85651 },
  });
  assert.equal(piatta.length, 2);
  assert.equal(must(piatta.find((r) => r.quote === "USD"), "il record USD").rate, "1.1523");

  const annidata = fx.normalizeFrankfurter({
    base: "EUR",
    rates: { "2026-08-03": { USD: 1.1501 }, "2026-08-04": { USD: 1.1523 } },
  });
  assert.equal(annidata.length, 2);
  assert.deepEqual(annidata.map((r) => r.date).sort(), ["2026-08-03", "2026-08-04"]);
});

test("normalizeFrankfurter scarta i tassi non positivi o mancanti", () => {
  const recs = fx.normalizeFrankfurter([
    { date: "2026-08-04", base: "EUR", quote: "USD", rate: 1.15 },
    { date: "2026-08-04", base: "EUR", quote: "XXX", rate: 0 },
    { date: "2026-08-04", base: "EUR", quote: "YYY", rate: -1 },
    { date: "2026-08-04", base: "EUR", quote: "ZZZ", rate: null },
    { date: null, base: "EUR", quote: "AAA", rate: 1 },
  ]);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].quote, "USD");
});

test("normalizeFrankfurter su input inattesi restituisce lista vuota, non lancia", () => {
  assert.deepEqual(fx.normalizeFrankfurter(null), []);
  assert.deepEqual(fx.normalizeFrankfurter({}), []);
  assert.deepEqual(fx.normalizeFrankfurter("stringa"), []);
  assert.deepEqual(fx.normalizeFrankfurter([]), []);
});

// ---------------------------------------------------------------------------
// Helper numerici e di data
// ---------------------------------------------------------------------------

test("numStr non produce MAI notazione esponenziale", () => {
  assert.equal(yp.numStr(127.325), "127.325");
  assert.equal(yp.numStr(0), "0");
  assert.ok(
    !must(yp.numStr(0.0000001), "numStr(1e-7)").includes("e"),
    "1e-7 non deve restare esponenziale"
  );
  assert.equal(yp.numStr(80791200), "80791200");
  assert.equal(yp.numStr(null), null);
  assert.equal(yp.numStr(undefined), null);
  assert.equal(yp.numStr(NaN), null);
  assert.equal(yp.numStr(Infinity), null);
  assert.equal(yp.numStr("82.216"), "82.216");
});

test("dateStr gestisce Date, ISO, epoch in secondi e in millisecondi", () => {
  assert.equal(yp.dateStr("2026-08-04T14:14:56.000Z"), "2026-08-04");
  assert.equal(yp.dateStr("2026-08-04"), "2026-08-04");
  assert.equal(yp.dateStr(new Date(Date.UTC(2026, 7, 4))), "2026-08-04");
  assert.equal(yp.dateStr(1754308800), "2025-08-04", "epoch in secondi");
  assert.equal(yp.dateStr(1754308800000), "2025-08-04", "epoch in millisecondi");
  assert.equal(yp.dateStr(null), null);
  assert.equal(yp.dateStr("spazzatura"), null);
});

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------

test("il circuit breaker si apre dopo 3 fallimenti consecutivi", () => {
  const b = new yp.CircuitBreaker({ threshold: 3, cooldownMs: 60000 });
  assert.equal(b.open, false);
  b.recordFailure();
  b.recordFailure();
  assert.equal(b.open, false, "due fallimenti non bastano");
  b.recordFailure();
  assert.equal(b.open, true);
  assert.equal(b.status.failures, 3);
});

test("un successo azzera il contatore dei fallimenti", () => {
  const b = new yp.CircuitBreaker({ threshold: 3 });
  b.recordFailure();
  b.recordFailure();
  b.recordSuccess();
  b.recordFailure();
  assert.equal(b.open, false, "il conteggio deve ripartire da zero");
});

test("il breaker si richiude da solo dopo il cooldown (half-open)", () => {
  const b = new yp.CircuitBreaker({ threshold: 1, cooldownMs: 0 });
  b.recordFailure();
  // cooldown 0 → alla lettura successiva è già scaduto.
  assert.equal(b.open, false, "scaduto il cooldown si riprova");
  assert.equal(b.status.failures, 0);
});

test("isRetryable distingue rate limit e problemi di rete da un simbolo inesistente", () => {
  assert.equal(yp.isRetryable(new Error("429 Too Many Requests")), true);
  assert.equal(yp.isRetryable(new Error("Rate limit exceeded")), true);
  assert.equal(yp.isRetryable(new Error("503 Service Unavailable")), true);
  assert.equal(yp.isRetryable(new Error("ETIMEDOUT")), true);
  assert.equal(yp.isRetryable(new Error("socket hang up")), true);
  assert.equal(yp.isRetryable(new Error("ECONNRESET")), true);
  // Un simbolo che non esiste non migliora ritentando.
  assert.equal(yp.isRetryable(new Error("Quote not found for symbol: PIPPO")), false);
  assert.equal(yp.isRetryable(new Error("404")), false);
});

// ---------------------------------------------------------------------------
// L'adapter pino (previene una violazione silenziosa)
// ---------------------------------------------------------------------------

test("pinoAdapter fornisce TUTTI E CINQUE i metodi che la libreria valida", () => {
  // Il logger di DEFAULT di yahoo-finance2 è console.*, che su questa piattaforma
  // NON viene inoltrato via OTLP. La libreria valida la presenza dei metodi in
  // costruzione: uno mancante fa fallire il `new`, e `dir` è quello che si dimentica.
  const adapter = yp.pinoAdapter as unknown as Record<string, unknown>;
  for (const m of ["info", "warn", "error", "debug", "dir"]) {
    assert.equal(typeof adapter[m], "function", `manca ${m}`);
  }
});

test("pinoAdapter non lancia su oggetti circolari", () => {
  // Il letterale non può riferirsi a se stesso: il tipo va dichiarato.
  const circular: { a: number; self?: unknown } = { a: 1 };
  circular.self = circular;
  assert.doesNotThrow(() => yp.pinoAdapter.dir(circular));
  assert.doesNotThrow(() => yp.pinoAdapter.info("stringa", 42, null, undefined));
});

// ---------------------------------------------------------------------------
// Confine architetturale
// ---------------------------------------------------------------------------

test("market/ non importa MAI domain/ (confine architetturale)", () => {
  const dir = path.join(__dirname, "..", "..", "src", "market");
  for (const { file, src } of readSources(dir)) {
    // Anche i soli tipi: market/ non deve conoscere nemmeno la forma di domain/.
    for (const { spec } of importsOf(src)) {
      assert.ok(
        !spec.includes("domain/"),
        `${file} importa ${spec}: market/ normalizza i payload e li passa a repo/, non tocca domain/`
      );
    }
  }
});
