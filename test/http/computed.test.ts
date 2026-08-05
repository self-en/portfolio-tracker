// Test golden-file degli endpoint calcolati: un ledger fixture → assert sulla
// risposta JSON intera.
//
// Gira contro l'app REALE (fastify + repo + domain) con pg-mem come database, così
// copre l'orchestrazione — che è dove i pezzi corretti si combinano in modo
// sbagliato.
// Per PRIMO: imposta l'env prima che qualsiasi import carichi src/config.
import { TEST_PASSWORD } from "../helpers/env";

import test from "node:test";
import assert from "node:assert/strict";

import { freshMemDb } from "../helpers/memdb";
import type { FastifyInstance } from "fastify";

let server: FastifyInstance;
let base: string;
let cookie: string;

async function startApp() {
  await freshMemDb();

  // require e non import: boot e app leggono la config al load e vanno caricati
  // DOPO che freshMemDb ha installato il pool di pg-mem. `typeof import(...)`
  // recupera i tipi che un require nudo perderebbe.
  const boot = require("../../src/boot") as typeof import("../../src/boot");
  boot.state.ready = true;
  boot.state.db.connected = true;

  const { buildApp } = require("../../src/app") as typeof import("../../src/app");
  server = await buildApp();
  base = await server.listen({ port: 0, host: "127.0.0.1" });

  const res = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: TEST_PASSWORD }),
  });
  assert.equal(res.status, 204);
  cookie = res.headers.getSetCookie()[0].split(";")[0];
}

/**
 * Una chiamata all'API, con il cookie di sessione già attaccato.
 *
 * `T` è la forma attesa della risposta e vale `any` per default: questi sono test
 * GOLDEN-FILE, il corpo È il soggetto delle asserzioni, e il server non esporta i
 * tipi delle risposte (le route costruiscono oggetti inline). Dichiararne qui una
 * copia sarebbe una terza verità da tenere allineata a mano, mentre le asserzioni
 * che seguono già verificano campo per campo. Chi vuole precisione passa `T`.
 */
async function api<T = any>(
  path: string,
  opts: RequestInit = {}
): Promise<{ status: number; body: T }> {
  const res = await fetch(`${base}${path}`, {
    ...opts,
    headers: { "content-type": "application/json", cookie, ...(opts.headers || {}) },
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body: body as T };
}

// --- Il ledger fixture ---------------------------------------------------------
//
// Un portafoglio piccolo ma che esercita ogni percorso: ETF in EUR, azione in USD,
// BTP a prezzo manuale, uno split, un dividendo lordo+ritenuta, una vendita
// parziale.

const ETF = {
  assetClass: "ETF",
  name: "iShares Core MSCI World",
  ticker: "EUNL.DE",
  isin: "IE00B4L5Y983",
  currency: "EUR",
  exchange: "XETRA",
};
const USD_STOCK = {
  assetClass: "EQUITY",
  name: "Apple Inc",
  ticker: "AAPL",
  isin: "US0378331005",
  currency: "USD",
};
const BTP = {
  assetClass: "BOND",
  name: "BTP 3,45% 01/07/2030",
  isin: "IT0005611741",
  currency: "EUR",
  priceSource: "manual",
  quoteConvention: "PCT_OF_NOMINAL",
  faceValue: "1000",
  couponRate: "0.0345",
  couponFrequency: 2,
  firstCouponDate: "2025-01-01",
  maturityDate: "2030-07-01",
  dayCount: "ACT/ACT-ICMA",
};

/** Gli id assegnati dal server agli strumenti del ledger fixture. */
const ids: Record<string, number> = {};

test("setup: avvio app, creazione strumenti e ledger", async () => {
  await startApp();

  const daCreare: Array<[string, object]> = [
    ["etf", ETF],
    ["usd", USD_STOCK],
    ["btp", BTP],
  ];
  for (const [key, inst] of daCreare) {
    const r = await api("/api/instruments", { method: "POST", body: JSON.stringify(inst) });
    assert.equal(r.status, 201, `creazione ${key}: ${JSON.stringify(r.body)}`);
    ids[key] = r.body.id;
  }

  const tx = (o: object) => api("/api/transactions", { method: "POST", body: JSON.stringify(o) });

  // ETF: 100 @ 80 con 5 di commissioni → carico 8005
  let r = await tx({ instrumentId: ids.etf, type: "BUY", tradeDate: "2025-01-15", quantity: "100", price: "80", fees: "5" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  // ETF: altri 50 @ 100 con 5 → carico 8005 + 5005 = 13010, medio 86.7333...
  r = await tx({ instrumentId: ids.etf, type: "BUY", tradeDate: "2025-06-10", quantity: "50", price: "100", fees: "5" });
  assert.equal(r.status, 201);
  // ETF: vendita 30 @ 120 con 5
  r = await tx({ instrumentId: ids.etf, type: "SELL", tradeDate: "2026-02-10", quantity: "30", price: "120", fees: "5" });
  assert.equal(r.status, 201);

  // AAPL in USD: 10 @ 150, cambio EURUSD 1,25 → carico 1200 EUR
  r = await tx({
    instrumentId: ids.usd, type: "BUY", tradeDate: "2025-03-01",
    quantity: "10", price: "150", tradeCcy: "USD", fxRate: "1.25",
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  // Split 4:1
  r = await tx({ instrumentId: ids.usd, type: "SPLIT", tradeDate: "2025-09-01", splitRatio: "4", tradeCcy: "USD", fxRate: "1.25" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  // Dividendo lordo 40 USD, ritenuta 6 USD, cambio 1,25 → 32 lordi EUR, 4,80 ritenuta
  r = await tx({
    instrumentId: ids.usd, type: "DIVIDEND", tradeDate: "2025-11-15",
    grossAmount: "40", taxes: "6", tradeCcy: "USD", fxRate: "1.25",
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));

  // BTP: nominale 10.000 al 98,5 + 8 commissioni → carico 9858 (rateo escluso)
  r = await tx({ instrumentId: ids.btp, type: "BUY", tradeDate: "2025-04-02", nominal: "10000", price: "98.5", fees: "8" });
  assert.equal(r.status, 201, JSON.stringify(r.body));

  // Prezzi: chiusure per l'ETF e AAPL, prezzo manuale per il BTP.
  const chiusure: Array<[number, Array<[string, string]>]> = [
    [ids.etf, [["2025-01-15", "80"], ["2026-02-10", "120"], ["2026-08-04", "125"]]],
    // Serie AAPL già AGGIUSTATA per lo split (come la restituisce Yahoo).
    [ids.usd, [["2025-03-01", "37.5"], ["2026-08-04", "50"]]],
  ];
  for (const [id, rows] of chiusure) {
    for (const [date, close] of rows) {
      const rr = await api(`/api/instruments/${id}/prices`, {
        method: "PUT",
        body: JSON.stringify({ date, close }),
      });
      assert.equal(rr.status, 200, JSON.stringify(rr.body));
    }
  }
  const rb = await api(`/api/instruments/${ids.btp}/prices`, {
    method: "PUT",
    body: JSON.stringify({ date: "2026-08-04", close: "101.25" }),
  });
  assert.equal(rb.status, 200);

  // Cambio EURUSD.
  const { upsertRates } = require("../../src/repo/fx") as typeof import("../../src/repo/fx");
  await upsertRates([
    { date: "2025-03-01", quote: "USD", rate: "1.25" },
    { date: "2026-08-04", quote: "USD", rate: "1.25" },
  ]);
});

test("GET /api/portfolio/positions: carico, latente e redditi per strumento", async () => {
  const r = await api("/api/portfolio/positions?asOf=2026-08-04");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const byName = new Map<string, any>(r.body.items.map((x: any) => [x.instrument.name, x]));

  // --- ETF: 150 comprate, 30 vendute → 120 residue.
  // Carico dopo i due acquisti = 8005 + 5005 = 13010 su 150 → medio 86,733333
  // Vendita 30: incasso 3600 - 5 = 3595; costo rimosso 30 × 86,733333 = 2602
  // → realizzato 993, carico residuo 10408
  const etf = byName.get("iShares Core MSCI World");
  assert.equal(etf.quantity, "120.00000000");
  assert.equal(Number(etf.costBasis).toFixed(2), "10408.00");
  assert.equal(Number(etf.avgCost).toFixed(4), "86.7333");
  assert.equal(Number(etf.realizedPnl).toFixed(2), "993.00");
  // Valore: 120 × 125 = 15000, latente 15000 - 10408 = 4592
  assert.equal(Number(etf.marketValueBase).toFixed(2), "15000.00");
  assert.equal(Number(etf.unrealizedPnl).toFixed(2), "4592.00");

  // --- AAPL: 10 comprate, split 4:1 → 40 quote. Carico 1200 EUR invariato.
  const aapl = byName.get("Apple Inc");
  assert.equal(aapl.quantity, "40.00000000", "lo split moltiplica la quantità");
  assert.equal(Number(aapl.costBasis).toFixed(2), "1200.00", "lo split NON tocca il carico");
  assert.equal(Number(aapl.avgCost).toFixed(2), "30.00", "il costo medio si divide per 4");
  // Valore: 40 × 50 USD = 2000 USD / 1,25 = 1600 EUR
  assert.equal(Number(aapl.marketValueBase).toFixed(2), "1600.00");
  assert.equal(Number(aapl.unrealizedPnl).toFixed(2), "400.00");
  // Dividendo: 40 USD lordi / 1,25 = 32 EUR; ritenuta 6 / 1,25 = 4,80
  assert.equal(Number(aapl.incomeGross).toFixed(2), "32.00");
  assert.equal(Number(aapl.taxWithheld).toFixed(2), "4.80");
  assert.equal(Number(aapl.incomeNet).toFixed(2), "27.20");
  assert.equal(aapl.fxRate, "1.2500000000");

  // --- BTP: nominale 10.000, prezzo 101,25 → 10.125. Carico 9858 (rateo escluso).
  const btp = byName.get("BTP 3,45% 01/07/2030");
  assert.equal(btp.quantity, "10.00000000");
  assert.equal(btp.nominal, "10000.000000", "il nominale è esposto: è quello che mostra il broker");
  assert.equal(Number(btp.costBasis).toFixed(2), "9858.00");
  assert.equal(Number(btp.marketValueBase).toFixed(2), "10125.00");
  assert.equal(Number(btp.unrealizedPnl).toFixed(2), "267.00");
  // Il rateo al 2026-08-04: periodo 2026-07-01 → 2027-01-01, 34 giorni su 184.
  assert.ok(Number(btp.accruedInterest) > 0, "il rateo è riportato a parte");
  assert.ok(Number(btp.accruedInterest) < 172.5, "e non supera una cedola intera");

  // Tutti i numerici sono STRINGHE sul filo.
  for (const it of r.body.items) {
    for (const k of ["quantity", "costBasis", "marketValueBase", "realizedPnl"]) {
      assert.equal(typeof it[k], "string", `${it.instrument.name}.${k} deve essere stringa`);
    }
  }
});

test("GET /api/portfolio/summary: i totali tornano, e le tre voci restano separate", async () => {
  const r = await api("/api/portfolio/summary?asOf=2026-08-04");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const b = r.body;

  // Valore: 15000 (ETF) + 1600 (AAPL) + 10125 (BTP) = 26725
  assert.equal(Number(b.marketValue).toFixed(2), "26725.00");
  // Carico: 10408 + 1200 + 9858 = 21466
  assert.equal(Number(b.costBasis).toFixed(2), "21466.00");
  assert.equal(Number(b.unrealizedPnl).toFixed(2), "5259.00");
  assert.equal(Number(b.realizedPnl).toFixed(2), "993.00");
  assert.equal(Number(b.incomeGross).toFixed(2), "32.00");
  assert.equal(Number(b.taxWithheld).toFixed(2), "4.80");
  assert.equal(Number(b.incomeNet).toFixed(2), "27.20");
  // Commissioni: 5 + 5 + 5 (ETF) + 8 (BTP) = 23
  assert.equal(Number(b.feesTotal).toFixed(2), "23.00");

  // NESSUN campo che somma realizzato + redditi + latente in un unico "profitto".
  assert.equal(b.totalProfit, undefined);
  assert.equal(b.profit, undefined);
  assert.ok(b.disclaimer.includes("Non è consulenza fiscale"));

  // I pesi per asset class sommano a 1.
  const sum = b.byAssetClass.reduce((a: any, g: any) => a + Number(g.weight), 0);
  assert.ok(Math.abs(sum - 1) < 1e-4, `pesi = ${sum}`);
  assert.deepEqual(
    b.byAssetClass.map((g: any) => g.assetClass).sort(),
    ["BOND", "EQUITY", "ETF"]
  );

  // Le percentuali sono FRAZIONI (0.245), non percentuali (24.5).
  assert.ok(Number(b.unrealizedPnlPct) > 0 && Number(b.unrealizedPnlPct) < 1);

  // XIRR e TWR presenti e finiti.
  assert.ok(b.xirr !== null, "lo XIRR deve essere calcolato");
  assert.ok(Number.isFinite(Number(b.xirr)));
  assert.ok(b.twr.total !== null);
});

test("GET /api/portfolio/value-series: nessun salto sullo split, punti coerenti", async () => {
  const r = await api("/api/portfolio/value-series?range=ALL&granularity=day&asOf=2026-08-04");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const pts = r.body.points;
  assert.ok(pts.length > 100);
  assert.equal(pts[0].date, "2025-01-15", "la serie parte dalla prima transazione");
  assert.equal(pts[pts.length - 1].date, "2026-08-04");

  // NESSUN SALTO attorno allo split del 2025-09-01: la serie close di AAPL è già
  // aggiustata e la quantità viene riportata in quote odierne, quindi il valore è
  // continuo. Un doppio conteggio si vedrebbe come un quadruplicarsi improvviso.
  const i = pts.findIndex((p: any) => p.date === "2025-09-01");
  const before = Number(pts[i - 1].value);
  const after = Number(pts[i].value);
  assert.ok(
    Math.abs(after - before) < before * 0.02,
    `salto sullo split: ${before} → ${after} (doppio conteggio?)`
  );

  // L'investito netto è monotono crescente finché non si vende — E NON SCENDE quando
  // arriva un dividendo (il 2025-11-15 c'è uno stacco): incassare un dividendo non
  // riduce quanto hai investito. È la distinzione tra flussi di capitale e flussi di
  // reddito: gli stessi flussi contano per il TWR, ma non per questa linea.
  const preSale = pts.filter((p: any) => p.date < "2026-02-10");
  for (let k = 1; k < preSale.length; k++) {
    assert.ok(
      Number(preSale[k].netInvested) >= Number(preSale[k - 1].netInvested) - 1e-6,
      `investito netto in calo al ${preSale[k].date}`
    );
  }
  const divDay = pts.find((p: any) => p.date === "2025-11-15");
  const dayBefore = pts.find((p: any) => p.date === "2025-11-14");
  assert.equal(
    divDay.netInvested,
    dayBefore.netInvested,
    "un dividendo non deve muovere l'investito netto"
  );

  // Il valore finale coincide con il summary.
  assert.equal(Number(pts[pts.length - 1].value).toFixed(2), "26725.00");
  assert.equal(r.body.meta.granularity, "day");
  assert.equal(typeof r.body.meta.partialPoints, "number");
});

test("value-series: i punti prima del primo prezzo sono `partial`, non zero silenzioso", async () => {
  // Il BTP ha un solo prezzo manuale, al 2026-08-04: tutti i giorni precedenti dal
  // suo acquisto non hanno prezzo. Devono essere marcati, non silenziosamente a zero.
  const r = await api("/api/portfolio/value-series?range=ALL&granularity=day&asOf=2026-08-04");
  const partials = r.body.points.filter((p: any) => p.partial);
  assert.ok(partials.length > 0, "devono esserci punti parziali");
  assert.ok(
    r.body.meta.warnings.some((w: any) => w.code === "price_missing"),
    "e un warning che spiega quale strumento manca"
  );
  assert.equal(r.body.meta.partialPoints, partials.length);
  // L'ultimo punto invece è completo: tutti e tre gli strumenti hanno un prezzo.
  assert.equal(r.body.points[r.body.points.length - 1].partial, false);
});

test("GET /api/portfolio/allocation: per asset class, valuta e strumento", async () => {
  for (const by of ["assetClass", "currency", "instrument"]) {
    const r = await api(`/api/portfolio/allocation?by=${by}&asOf=2026-08-04`);
    assert.equal(r.status, 200);
    assert.equal(r.body.by, by);
    const sum = r.body.items.reduce((a: any, g: any) => a + Number(g.weight), 0);
    assert.ok(Math.abs(sum - 1) < 1e-4, `${by}: pesi = ${sum}`);
    // Ordine decrescente per valore.
    for (let i = 1; i < r.body.items.length; i++) {
      assert.ok(
        Number(r.body.items[i - 1].marketValue) >= Number(r.body.items[i].marketValue),
        `${by} non ordinato`
      );
    }
  }
  // Per valuta: EUR (ETF+BTP) e USD (AAPL).
  const cur = await api("/api/portfolio/allocation?by=currency&asOf=2026-08-04");
  assert.deepEqual(cur.body.items.map((g: any) => g.key).sort(), ["EUR", "USD"]);
});

test("GET /api/portfolio/returns: TWR, XIRR, byYear e flussi", async () => {
  const r = await api("/api/portfolio/returns?range=ALL&asOf=2026-08-04");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.twr.total !== null);
  assert.ok(r.body.xirr !== null);
  assert.ok(["newton", "bisection"].includes(r.body.xirrMethod));
  assert.ok(Array.isArray(r.body.byYear));
  assert.ok(r.body.byYear.length >= 1);
  // I flussi hanno il segno dell'investitore: gli acquisti sono negativi.
  const buys = r.body.flows.filter((f: any) => f.type === "BUY");
  assert.ok(buys.length >= 4);
  for (const f of buys) assert.ok(Number(f.amount) < 0, "un acquisto è un'uscita di cassa");
  const divs = r.body.flows.filter((f: any) => f.type === "DIVIDEND");
  assert.ok(Number(divs[0].amount) > 0, "un dividendo è un'entrata");
  // Le due metriche sono spiegate nella risposta: sono facili da confondere.
  assert.ok(r.body.notes.xirr.includes("MWR"));
  assert.ok(r.body.notes.twr.includes("indipendente"));
});

test("GET /api/portfolio/income: lordo, ritenuta e netto per mese", async () => {
  const r = await api("/api/portfolio/income?groupBy=month");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.items.length, 1);
  assert.equal(r.body.items[0].key, "2025-11");
  // In valuta di transazione (USD): lordo 40, ritenuta 6, netto 34.
  assert.equal(Number(r.body.items[0].gross).toFixed(2), "40.00");
  assert.equal(Number(r.body.items[0].taxes).toFixed(2), "6.00");
  assert.equal(Number(r.body.items[0].net).toFixed(2), "34.00");
  assert.equal(Number(r.body.totals.gross).toFixed(2), "40.00");
});

test("GET /api/calendar: le cedole del BTP esistono SENZA copertura provider", async () => {
  // È la prova che il calendario funziona con copertura Yahoo pari a zero: le cedole
  // ci sono perché lo scadenzario le ha generate alla creazione dello strumento.
  const r = await api("/api/calendar?from=2026-01-01&to=2027-12-31");
  assert.equal(r.status, 200, JSON.stringify(r.body));

  const coupons = r.body.events.filter((e: any) => e.kind === "COUPON");
  assert.ok(coupons.length >= 3, `attese più cedole, trovate ${coupons.length}`);
  assert.deepEqual(
    coupons.map((c: any) => c.payDate).slice(0, 4),
    ["2026-01-01", "2026-07-01", "2027-01-01", "2027-07-01"]
  );

  const c = coupons.find((x: any) => x.payDate === "2027-01-01");
  assert.equal(c.confidence, "scheduled", "generata dallo scadenzario, non dal provider");
  assert.equal(c.status, "PROJECTED");
  // Number(): pg-mem restituisce i NUMERIC come number, il contratto stringa è
  // verificato in test/db/typeParsers.test.js e sull'env di branch.
  assert.equal(Number(c.amountPerUnit).toFixed(3), "1.725", "per 100 di nominale");
  assert.equal(c.amountUnit, "per_100_nominale", "la convenzione è dichiarata");
  assert.equal(c.quantityAtDate, "10.00000000");
  // 10.000 nominali × 1,725 / 100 = 172,50
  assert.equal(Number(c.estimatedGross).toFixed(2), "172.50");
  assert.equal(Number(c.estimatedGrossBase).toFixed(2), "172.50");

  // I totali mensili separano confermato e proiettato (la UI li distingue con la
  // texture, non con una seconda tinta).
  const m = r.body.monthlyTotals.find((x: any) => x.month === "2027-01");
  assert.equal(Number(m.gross).toFixed(2), "172.50");
  assert.equal(Number(m.projected).toFixed(2), "172.50");
  assert.equal(Number(m.confirmed).toFixed(2), "0.00");
});

test("il calendario NON somma i rimborsi ai totali di reddito", async () => {
  // Un rimborso a scadenza è capitale che rientra: sommarlo gonfierebbe il grafico
  // dei redditi di un ordine di grandezza (10.000 contro 172,50).
  const r = await api("/api/calendar?from=2030-01-01&to=2030-12-31");
  const redemption = r.body.events.find((e: any) => e.kind === "REDEMPTION");
  assert.ok(redemption, "il rimborso deve comparire nel calendario");
  assert.equal(Number(redemption.estimatedGross).toFixed(2), "10000.00");

  const july = r.body.monthlyTotals.find((x: any) => x.month === "2030-07");
  // Solo la cedola, non il rimborso.
  assert.equal(Number(july.gross).toFixed(2), "172.50");
});

test("POST /api/calendar/:id/confirm crea la transazione COUPON e collega l'evento", async () => {
  // È l'idea di UX a maggior valore del piano: il calendario diventa il canale
  // primario di data entry.
  const list = await api("/api/calendar?from=2026-01-01&to=2026-12-31");
  const coupon = list.body.events.find((e: any) => e.kind === "COUPON" && e.status === "PROJECTED");
  assert.ok(coupon);

  // Ritenuta 12,5% sui titoli di Stato: 172,50 × 0,125 = 21,5625
  const r = await api(`/api/calendar/${coupon.id}/confirm`, {
    method: "POST",
    body: JSON.stringify({ taxes: "21.5625" }),
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.event.status, "PAID");
  assert.equal(r.body.transaction.type, "COUPON");
  // Il lordo arriva precompilato dallo scadenzario.
  assert.equal(Number(r.body.transaction.grossAmount).toFixed(2), "172.50");
  assert.equal(Number(r.body.transaction.netAmount).toFixed(4), "150.9375");
  assert.equal(r.body.transaction.tradeDate, coupon.payDate);
  assert.equal(r.body.event.transactionId, r.body.transaction.id);

  // Ora la cedola risulta incassata, con confidence 'paid'.
  const after = await api("/api/calendar?from=2026-01-01&to=2026-12-31");
  const same = after.body.events.find((e: any) => e.id === coupon.id);
  assert.equal(same.confidence, "paid");
  assert.equal(same.transactionId, r.body.transaction.id);

  // E una seconda conferma è un conflitto, non un doppio movimento.
  const again = await api(`/api/calendar/${coupon.id}/confirm`, {
    method: "POST",
    body: JSON.stringify({ taxes: "21.5625" }),
  });
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, "conflict");
});

test("il reddito confermato compare in /portfolio/income e nel summary", async () => {
  const inc = await api("/api/portfolio/income?groupBy=month");
  const jan = inc.body.items.find((x: any) => x.key === "2026-01");
  assert.ok(jan, "la cedola confermata deve comparire tra i redditi");
  assert.equal(Number(jan.gross).toFixed(2), "172.50");
  assert.equal(Number(jan.taxes).toFixed(4), "21.5625");

  const sum = await api("/api/portfolio/summary?asOf=2026-08-04");
  // 32 (dividendo AAPL) + 172,50 (cedola) = 204,50
  assert.equal(Number(sum.body.incomeGross).toFixed(2), "204.50");
  assert.equal(Number(sum.body.taxWithheld).toFixed(4), "26.3625");
});

test("il rimborso a scadenza NON si conferma come reddito: indica la via corretta", async () => {
  const list = await api("/api/calendar?from=2030-01-01&to=2030-12-31");
  const red = list.body.events.find((e: any) => e.kind === "REDEMPTION");
  const r = await api(`/api/calendar/${red.id}/confirm`, { method: "POST", body: "{}" });
  assert.equal(r.status, 422);
  assert.match(r.body.error.message, /vendita al 100/);
  assert.ok(r.body.error.details.hint.includes("SELL"));
});

test("includeAccrued commuta il totale tra corso secco e tel quel", async () => {
  const secco = await api("/api/portfolio/summary?asOf=2026-08-04");
  const telQuel = await api("/api/portfolio/summary?asOf=2026-08-04&includeAccrued=true");
  assert.equal(secco.body.marketValue, telQuel.body.marketValue, "il valore secco non cambia");
  assert.ok(
    Number(telQuel.body.totalValue) > Number(secco.body.totalValue),
    "il tel quel include il rateo"
  );
  const diff = Number(telQuel.body.totalValue) - Number(secco.body.totalValue);
  assert.ok(Math.abs(diff - Number(secco.body.accruedInterest)) < 0.01);
});

test("GET /api/export produce un dump completo e reimportabile", async () => {
  const r = await api("/api/export");
  assert.equal(r.status, 200);
  assert.equal(r.body.format, "portfolio-tracker");
  assert.equal(r.body.version, 1);
  assert.equal(r.body.instruments.length, 3);
  assert.ok(r.body.transactions.length >= 8);
  // I prezzi manuali sono SEMPRE inclusi: per le obbligazioni sono l'unico dato
  // che nessun provider può rigenerare.
  assert.ok(r.body.manualPrices.length >= 1);
  const btpPrices = r.body.manualPrices.find((g: any) => g.instrumentIsin === "IT0005611741");
  assert.ok(btpPrices, "i prezzi manuali del BTP devono esserci");
  assert.equal(btpPrices.prices[0].date, "2026-08-04");
  // Le cedole proiettate NON sono esportate: sono derivate, si rigenerano.
  assert.ok(r.body.events.every((e: any) => e.status !== "PROJECTED" || e.transactionId));
});

test("import in modalità replace ricostruisce lo stesso portafoglio", async () => {
  const dump = (await api("/api/export")).body;
  const before = await api("/api/portfolio/summary?asOf=2026-08-04");

  const imp = await api("/api/import", {
    method: "POST",
    body: JSON.stringify({ ...dump, replace: true }),
  });
  assert.equal(imp.status, 200, JSON.stringify(imp.body));
  assert.equal(imp.body.imported.instruments, 3);
  assert.ok(imp.body.imported.transactions >= 8);
  assert.ok(imp.body.imported.manualPrices >= 1);

  const after = await api("/api/portfolio/summary?asOf=2026-08-04");
  // I numeri devono coincidere: è il test che dimostra che l'export è davvero una
  // rete di sicurezza e non un file che sembra completo.
  assert.equal(after.body.costBasis, before.body.costBasis);
  assert.equal(after.body.realizedPnl, before.body.realizedPnl);
  assert.equal(after.body.incomeGross, before.body.incomeGross);
  assert.equal(after.body.marketValue, before.body.marketValue);

  // E le cedole proiettate sono state RIGENERATE, non importate.
  const cal2 = await api("/api/calendar?from=2027-01-01&to=2027-12-31");
  assert.ok(cal2.body.events.filter((e: any) => e.kind === "COUPON").length >= 2);
});

test("teardown", async () => {
  await server.close();
});
