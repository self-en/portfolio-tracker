// Metriche di rischio: matematica pura, quindi verificabile a mano.
//
// Ogni caso qui usa numeri scelti perché il risultato atteso si calcola in testa —
// è l'unico modo di distinguere "il codice fa qualcosa" da "il codice fa la cosa
// giusta". Il confine architetturale di domain/ (solo decimal.js, nessun orologio) è
// già verificato in test/domain/money.test.ts, che scansiona tutta la directory.
import test from "node:test";
import assert from "node:assert/strict";

import { riskMetrics, _asOf, _sma } from "../../src/domain/riskMetrics";
import { addDays } from "../../src/domain/calendar";
import { must } from "../helpers/must";

/** Una serie giornaliera a partire da `start`, un punto per giorno. */
function series(start: string, closes: Array<string | null>) {
  return closes.map((close, i) => ({ date: addDays(start, i), close }));
}

test("serie vuota: niente metriche inventate", () => {
  const m = riskMetrics([], "2026-08-06");
  assert.equal(m.points, 0);
  assert.equal(m.last, null);
  assert.equal(m.volatility, null);
  assert.equal(m.maxDrawdown, null);
  assert.equal(m.trend, null);
  assert.deepEqual(m.returns, []);
});

test("scarta le osservazioni inutilizzabili (null, vuote, zero)", () => {
  // Uno zero NON è un prezzo: sarebbe un buco nei dati travestito da crollo, e in un
  // rapporto diventerebbe una divisione per zero (docs/decisions.md §5).
  const m = riskMetrics(series("2026-01-01", ["100", null, "", "0", "110"]), "2026-01-10");
  assert.equal(m.points, 2);
  assert.equal(m.last, "110");
  assert.equal(m.from, "2026-01-01");
  assert.equal(m.to, "2026-01-05");
});

test("massimo drawdown: dal massimo PRECEDENTE, non dal minimo assoluto", () => {
  // 100 → 120 → 90 → 130: il picco è 120, il fondo 90 → (90-120)/120 = -0,25.
  const m = riskMetrics(series("2026-01-01", ["100", "120", "90", "130"]), "2026-01-04");
  const dd = must(m.maxDrawdown, "il drawdown");
  assert.equal(dd.depth, "-0.25");
  assert.equal(dd.peakDate, "2026-01-02");
  assert.equal(dd.troughDate, "2026-01-03");
});

test("un minimo che viene PRIMA del massimo non è un drawdown", () => {
  // Serie solo crescente: nessuna discesa da un picco precedente.
  const m = riskMetrics(series("2026-01-01", ["50", "60", "70", "80"]), "2026-01-04");
  assert.equal(m.maxDrawdown, null);
});

test("massimi e minimi a 52 settimane guardano SOLO la finestra", () => {
  // Il 300 sta 400 giorni prima della data di riferimento: fuori finestra (364
  // giorni), quindi non deve diventare il massimo a 52 settimane.
  const asOfDate = "2026-08-06";
  const rows = [
    { date: addDays(asOfDate, -400), close: "300" },
    { date: addDays(asOfDate, -200), close: "100" },
    { date: addDays(asOfDate, -10), close: "150" },
    { date: asOfDate, close: "120" },
  ];
  const m = riskMetrics(rows, asOfDate);
  assert.equal(must(m.high52w, "il massimo").close, "150");
  assert.equal(must(m.low52w, "il minimo").close, "100");
  // Distanza dal massimo: (120-150)/150 = -0,2. Dal minimo: (120-100)/100 = +0,2.
  assert.equal(m.fromHigh52w, "-0.2");
  assert.equal(m.fromLow52w, "0.2");
  // Il punto fuori finestra resta nella serie (serve al drawdown e alle SMA): è la
  // FINESTRA a essere ristretta, non i dati a essere buttati.
  assert.equal(m.points, 4);
});

test("rendimenti per orizzonte: base con forward-fill, mai un periodo inventato", () => {
  const asOfDate = "2026-08-06";
  const rows = [
    // 12 mesi prima cade su un giorno senza prezzo: si usa l'ultima chiusura nota.
    { date: "2025-08-04", close: "100" },
    { date: "2026-02-06", close: "120" },
    { date: asOfDate, close: "150" },
  ];
  const m = riskMetrics(rows, asOfDate);
  const byHorizon = new Map(m.returns.map((r) => [r.horizon, r]));

  const r12 = must(byHorizon.get("12m"), "il rendimento a 12 mesi");
  assert.equal(r12.from, "2025-08-04", "forward-fill sulla base");
  assert.equal(r12.change, "0.5", "(150-100)/100");

  const r6 = must(byHorizon.get("6m"), "il rendimento a 6 mesi");
  assert.equal(r6.from, "2026-02-06");
  assert.equal(r6.change, "0.25", "(150-120)/120");

  // A 1 mese l'ultima chiusura nota prima della data richiesta è quella di sei mesi
  // prima: non è "il rendimento a 1 mese", è un altro periodo con l'etichetta
  // sbagliata. L'orizzonte si omette.
  assert.equal(byHorizon.has("1m"), false);
});

test("un orizzonte si omette anche quando la base è vecchia oltre la tolleranza", () => {
  // Una sola osservazione vecchia più l'ultima: la base del 6 mesi (6 febbraio) è a
  // 5 giorni dal 1° febbraio → valida; quella del 3 mesi (6 maggio) sarebbe a 94
  // giorni → l'orizzonte si omette invece di misurare il periodo sbagliato.
  const asOfDate = "2026-08-06";
  const rows = [
    { date: "2026-02-01", close: "100" },
    { date: asOfDate, close: "150" },
  ];
  const horizons = riskMetrics(rows, asOfDate).returns.map((r) => r.horizon);
  assert.equal(horizons.includes("3m"), false, "base troppo vecchia per un 3 mesi");
  assert.equal(horizons.includes("6m"), true, "il 6 mesi invece ha una base valida");
});

test("volatilità: serve un minimo di storia, e una crescita costante ha volatilità zero", () => {
  // 10 punti → meno di 20 rendimenti: nessuna volatilità.
  assert.equal(riskMetrics(series("2026-01-01", Array(10).fill("100")), "2026-01-10").volatility, null);

  // 30 punti con lo STESSO rendimento giornaliero (+10% composto): la deviazione
  // standard dei rendimenti è esattamente zero.
  let p = 100;
  const closes = Array.from({ length: 30 }, () => {
    const v = String(p);
    p = p * 1.1;
    return v;
  });
  const m = riskMetrics(series("2026-01-01", closes), "2026-02-15");
  assert.equal(m.volatility, "0");
});

test("volatilità di una serie alternata: valore atteso calcolato a mano", () => {
  // Prezzi che alternano 100 e 110: i rendimenti sono +0,1 e -1/11 in sequenza.
  const closes = Array.from({ length: 41 }, (_, i) => (i % 2 === 0 ? "100" : "110"));
  const m = riskMetrics(series("2026-01-01", closes), "2026-03-01");
  // media = (0,1 - 1/11)/2 = 0,00454545…; scarti = ±0,09545454…
  // Σ(scarto²) = 40 × 0,00911157… = 0,3644628…
  // varianza CAMPIONARIA (n-1 = 39) = 0,00934520…; × 252 = 2,354991…
  // annualizzata = √2,354991… = 1,534598…
  const vol = Number(must(m.volatility, "la volatilità"));
  assert.ok(Math.abs(vol - 1.534598) < 0.0001, `volatilità ${vol} lontana dall'attesa 1,534598`);
});

test("serie MENSILE: nessuna volatilità annualizzata con √252, e la lacuna è dichiarabile", () => {
  // IL CASO BTP: prezzo inserito a mano una volta al mese (docs/decisions.md §9).
  // I rendimenti tra osservazioni consecutive sono MENSILI: annualizzarli con √252
  // invece di √12 sovrastima la volatilità di circa 4,6 volte, e quel numero
  // finirebbe in un prompt che lo dichiara "annualizzato".
  const rows = Array.from({ length: 25 }, (_, i) => ({
    date: addDays("2024-02-15", i * 30),
    close: String(100 * (1 + (i % 2 === 0 ? 0.02 : -0.02))),
  }));
  const m = riskMetrics(rows, addDays("2024-02-15", 24 * 30));

  assert.equal(m.granularity, "sparse");
  assert.equal(m.volatility, null, "√252 non si applica a rendimenti mensili");
  assert.equal(m.sma50, null, "50 osservazioni mensili non sono 50 giorni");
  assert.equal(m.sma200, null);
  assert.equal(m.trend, null);
  // Ciò che resta valido resta: prezzo, range, drawdown, rendimenti per orizzonte.
  assert.ok(m.maxDrawdown, "il drawdown non dipende dal passo della serie");
  assert.ok(m.points === 25);
});

test("un solo buco lungo NON declassa una serie giornaliera (mediana, non media)", () => {
  // 40 giorni consecutivi, una pausa di tre settimane, altri 40 giorni: la mediana
  // dei divari resta 1 giorno, quindi la serie è giornaliera. Il rendimento a
  // cavallo del buco viene però escluso dalla deviazione standard.
  const primaMeta = Array.from({ length: 40 }, (_, i) => ({ date: addDays("2026-01-01", i), close: String(100 + i) }));
  const secondaMeta = Array.from({ length: 40 }, (_, i) => ({ date: addDays("2026-03-01", i), close: String(140 + i) }));
  const m = riskMetrics([...primaMeta, ...secondaMeta], "2026-04-15");
  assert.equal(m.granularity, "daily");
  assert.ok(m.volatility !== null, "la serie è giornaliera: la volatilità si calcola");
});

test("le metriche non guardano OLTRE la data di riferimento", () => {
  // Un prezzo manuale con data futura, o una richiesta su una data storica: `last`,
  // le medie e il drawdown devono fermarsi ad asOfDate, altrimenti il modulo non è
  // deterministico rispetto al parametro che dichiara di rispettare.
  const rows = [
    { date: "2025-01-10", close: "100" },
    { date: "2025-06-10", close: "120" },
    { date: "2026-06-10", close: "300" },
  ];
  const m = riskMetrics(rows, "2025-07-01");
  assert.equal(m.points, 2);
  assert.equal(m.last, "120");
  assert.equal(m.to, "2025-06-10");
  assert.equal(must(m.high52w, "il massimo").close, "120", "il 300 è nel futuro: non esiste");
});

test("SMA e trend: null finché la finestra non è piena", () => {
  const closes = Array.from({ length: 60 }, (_, i) => String(100 + i));
  const m = riskMetrics(series("2026-01-01", closes), "2026-03-01");
  // Ultimi 50 punti: da 110 a 159 → media 134,5.
  assert.equal(m.sma50, "134.5");
  assert.equal(m.sma200, null, "200 giorni non ci sono");
  // L'ultimo prezzo (159) è sopra la SMA50 e la SMA200 manca: trend "sopra".
  assert.equal(m.trend, "sopra");

  const short = riskMetrics(series("2026-01-01", ["100", "101"]), "2026-01-02");
  assert.equal(short.sma50, null);
  assert.equal(short.trend, null);
});

test("trend 'misto' quando il prezzo sta sotto una media e sopra l'altra", () => {
  // 220 punti in salita da 100 a 319, poi 10 punti a 250.
  //   SMA50  = (280…319) + 10×250 = 14.480/50 = 289,6 → 250 è SOTTO
  //   SMA200 = (130…319) + 10×250 = 45.155/200 = 225,775 → 250 è SOPRA
  const rising = Array.from({ length: 220 }, (_, i) => String(100 + i));
  const closes = [...rising, ...Array.from({ length: 10 }, () => "250")];
  const m = riskMetrics(series("2025-01-01", closes), "2025-09-01");
  assert.equal(m.sma50, "289.6");
  assert.equal(m.sma200, "225.775");
  assert.equal(m.trend, "misto");
});

test("_asOf restituisce l'ultima osservazione NON successiva alla data", () => {
  const rows = [
    { date: "2026-01-01", close: "10" },
    { date: "2026-01-10", close: "20" },
  ];
  assert.equal(must(_asOf(rows, "2026-01-05"), "il punto").close, "10");
  assert.equal(must(_asOf(rows, "2026-01-10"), "il punto").close, "20");
  assert.equal(must(_asOf(rows, "2026-06-01"), "il punto").close, "20", "forward-fill in avanti");
  assert.equal(_asOf(rows, "2025-12-31"), null, "prima della serie non si inventa nulla");
});

test("_sma non arrotonda prima del tempo", () => {
  // Media di 1 e 2 = 1,5: nessun troncamento a interi lungo la strada.
  assert.equal(_sma([{ date: "2026-01-01", close: "1" }, { date: "2026-01-02", close: "2" }], 2), "1.5");
});

test("i numerici escono come STRINGHE (mai float sul filo)", () => {
  const m = riskMetrics(series("2026-01-01", ["100", "120", "90", "130"]), "2026-01-04");
  assert.equal(typeof m.last, "string");
  assert.equal(typeof must(m.maxDrawdown, "il drawdown").depth, "string");
  assert.equal(typeof m.fromHigh52w, "string");
});
