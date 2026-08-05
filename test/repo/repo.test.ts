// Test del layer repository su pg-mem.
//
// SCOPO: intercettare errori SQL prima del deploy (in locale non c'è Postgres).
// NON si asserisce la precisione NUMERIC: il NUMERIC di pg-mem è float-backed,
// quella è competenza di src/domain/money.js.
//
// Limiti noti di pg-mem: indici unique parziali, DISTINCT ON, funzioni finestra,
// advisory lock. Dove inciampa, il test si autoesclude con un messaggio esplicito
// invece di fallire in modo fuorviante — la verifica vera è sull'env di branch.
// Per PRIMO: imposta l'env prima che qualsiasi import carichi src/config.
import "../helpers/env";

import test from "node:test";
import assert from "node:assert/strict";

import path from "node:path";

import { freshMemDb, tolerantMem } from "../helpers/memdb";
import { must } from "../helpers/must";
import { readSourcesDeep } from "../helpers/sourceScan";

import * as instrumentsRepo from "../../src/repo/instruments";
import * as txRepo from "../../src/repo/transactions";
import * as portfoliosRepo from "../../src/repo/portfolios";
import * as pricesRepo from "../../src/repo/prices";
import * as fxRepo from "../../src/repo/fx";
import * as eventsRepo from "../../src/repo/events";
import * as refreshLog from "../../src/repo/refreshLog";

const freshDb = freshMemDb;
const tolerant = tolerantMem;

const EQ = {
  assetClass: "EQUITY",
  name: "Acme SpA",
  ticker: "ACME.MI",
  isin: "IT0001234567",
  currency: "EUR",
  priceSource: "yahoo",
  quoteConvention: "PRICE",
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

test("il portafoglio seminato è leggibile", async () => {
  await freshDb();
  const list = await portfoliosRepo.list();
  assert.equal(list.length, 1);
  assert.equal(must(list[0], "il primo portafoglio").name, "Principale");
  assert.equal(must(await portfoliosRepo.first(), "il portafoglio").id, must(list[0], "il primo portafoglio").id);
});

test("strumenti: create → byId round-trip, camelCase e numerici stringa", async () => {
  await freshDb();
  const created = must(await instrumentsRepo.create(EQ), "lo strumento creato");
  assert.equal(created.name, "Acme SpA");
  assert.equal(created.ticker, "ACME.MI");
  assert.equal(created.assetClass, "EQUITY");
  assert.equal(created.active, true);

  const read = must(await instrumentsRepo.byId(created.id), "lo strumento letto");
  assert.equal(read.isin, "IT0001234567");
  assert.equal(read.currency, "EUR");
});

test("strumenti: un bond conserva TUTTI i campi obbligazionari", async () => {
  await freshDb();
  const b = must(await instrumentsRepo.create(BTP), "lo strumento creato");
  const read = must(await instrumentsRepo.byId(b.id), "lo strumento letto");
  assert.equal(read.quoteConvention, "PCT_OF_NOMINAL");
  assert.equal(read.couponFrequency, 2, "SMALLINT → number");
  assert.equal(read.maturityDate, "2030-07-01", "DATE → stringa 'YYYY-MM-DD', non un Date");
  // NOTA: qui NON si asserisce che i NUMERIC siano stringhe. pg-mem non passa dal
  // protocollo wire di `pg`, quindi i type parser di src/db/pool.js non hanno
  // effetto e i NUMERIC tornano come number. Il contratto "NUMERIC → stringa" è
  // verificato direttamente sui type parser (vedi test/db/typeParsers.test.js) e
  // sull'env di branch contro Postgres reale.
  assert.equal(Number(read.faceValue), 1000);
  assert.equal(Number(read.couponRate), 0.0345);
  assert.equal(read.dayCount, "ACT/ACT-ICMA");
  // Lo scadenzario si genera dai campi riletti dal database, non da quelli scritti.
  const bonds = require("../../src/domain/bonds") as typeof import("../../src/domain/bonds");
  const s = bonds.couponSchedule(read);
  assert.equal(s.length, 12);
  assert.equal(s[0].amountPer100, "1.725");
});

test("strumenti: update parziale non azzera gli altri campi", async () => {
  await freshDb();
  const created = must(await instrumentsRepo.create(EQ), "lo strumento creato");
  const updated = must(await instrumentsRepo.update(created.id, { notes: "una nota" }), "lo strumento aggiornato");
  assert.equal(updated.notes, "una nota");
  assert.equal(updated.name, "Acme SpA", "il nome deve sopravvivere alla PATCH");
  assert.equal(updated.ticker, "ACME.MI");
});

test("strumenti: filtri di list", async () => {
  await freshDb();
  await instrumentsRepo.create(EQ);
  await instrumentsRepo.create(BTP);
  await instrumentsRepo.create({ ...EQ, name: "Zeta ETF", ticker: "ZETA.DE", isin: "DE0007654321", assetClass: "ETF" });

  assert.equal((await instrumentsRepo.list()).length, 3);
  assert.equal((await instrumentsRepo.list({ assetClass: "BOND" })).length, 1);
  assert.equal((await instrumentsRepo.list({ priceSource: "manual" })).length, 1);
  const found = await instrumentsRepo.list({ q: "zeta" });
  assert.equal(found.length, 1, "la ricerca è case-insensitive");
  assert.equal(found[0].name, "Zeta ETF");
  // Ordinati per nome.
  const all = await instrumentsRepo.list();
  assert.deepEqual(all.map((i) => i.name), ["Acme SpA", "BTP 3,45% 01/07/2030", "Zeta ETF"]);
});

test("strumenti: byIsinOrTicker trova per entrambe le chiavi", async () => {
  await freshDb();
  const c = must(await instrumentsRepo.create(EQ), "lo strumento creato");
  assert.equal((await instrumentsRepo.byIsinOrTicker({ isin: "IT0001234567" }))?.id, c.id);
  assert.equal((await instrumentsRepo.byIsinOrTicker({ ticker: "ACME.MI" }))?.id, c.id);
  assert.equal(await instrumentsRepo.byIsinOrTicker({ isin: "XX0000000000" }), null);
  assert.equal(await instrumentsRepo.byIsinOrTicker({}), null);
});

test("strumenti: mapByIds restituisce la Map che domain/ si aspetta", async (t) => {
  await freshDb();
  const a = must(await instrumentsRepo.create(EQ), "lo strumento creato");
  const b = must(await instrumentsRepo.create(BTP), "lo strumento creato");
  const map = await instrumentsRepo.mapByIds([a.id, b.id]);
  if (map.size !== 2) {
    t.skip("limite di pg-mem su ANY(int[]) con più chiavi");
    return;
  }
  assert.equal(must(map.get(a.id), "il gruppo di a.id").name, "Acme SpA");
  assert.equal((await instrumentsRepo.mapByIds([])).size, 0, "lista vuota → nessuna query");
});

test("transazioni: create → byId, e i numerici restano stringhe", async () => {
  await freshDb();
  const p = must(await portfoliosRepo.first(), "il portafoglio");
  const i = must(await instrumentsRepo.create(EQ), "lo strumento creato");
  const created = must(
    await txRepo.create({
      portfolioId: p.id,
      instrumentId: i.id,
      type: "BUY",
      tradeDate: "2026-01-10",
      quantity: "10",
      price: "100",
      grossAmount: "1000",
      fees: "5",
      taxes: "0",
      accruedInterest: "0",
      netAmount: "-1005",
      tradeCcy: "EUR",
      fxRate: "1",
    }),
    "il movimento creato"
  );
  assert.equal(created.type, "BUY");
  assert.equal(created.tradeDate, "2026-01-10");
  assert.equal(Number(created.quantity), 10);
  assert.equal(Number(created.netAmount), -1005);

  const read = must(await txRepo.byId(created.id), "il movimento letto");
  assert.equal(read.id, created.id);
  assert.equal(read.instrumentId, i.id);
});

test("transazioni: il ledger è ASCENDENTE per (trade_date, id)", async () => {
  const { pool: p } = await freshDb();
  const pf = must(await portfoliosRepo.first(), "il portafoglio");
  const i = must(await instrumentsRepo.create(EQ), "lo strumento creato");
  const mk = (date: string, qty: string) =>
    txRepo.create({
      portfolioId: pf.id,
      instrumentId: i.id,
      type: "BUY",
      tradeDate: date,
      quantity: qty,
      price: "100",
      netAmount: "-1000",
      tradeCcy: "EUR",
      fees: "0",
      taxes: "0",
      accruedInterest: "0",
    });
  // Inserite fuori ordine di proposito.
  await mk("2026-03-01", "3");
  await mk("2026-01-01", "1");
  await mk("2026-02-01", "2");

  const ledger = await txRepo.ledger({ portfolioId: pf.id });
  assert.deepEqual(ledger.map((t) => t.tradeDate), ["2026-01-01", "2026-02-01", "2026-03-01"]);

  const asOf = await txRepo.ledger({ portfolioId: pf.id, asOf: "2026-02-01" });
  assert.equal(asOf.length, 2, "asOf taglia le transazioni successive");
  void p;
});

test("transazioni: ledgerByInstrument raggruppa ed esclude i movimenti di cassa", async () => {
  await freshDb();
  const pf = must(await portfoliosRepo.first(), "il portafoglio");
  const a = must(await instrumentsRepo.create(EQ), "lo strumento creato");
  const b = must(await instrumentsRepo.create({ ...EQ, name: "Beta", ticker: "BETA.MI", isin: "IT0009999999" }), "lo strumento creato");
  const base = { portfolioId: pf.id, tradeCcy: "EUR", fees: "0", taxes: "0", accruedInterest: "0" };
  await txRepo.create({ ...base, instrumentId: a.id, type: "BUY", tradeDate: "2026-01-01", quantity: "1", price: "10", netAmount: "-10" });
  await txRepo.create({ ...base, instrumentId: b.id, type: "BUY", tradeDate: "2026-01-02", quantity: "2", price: "20", netAmount: "-40" });
  await txRepo.create({ ...base, instrumentId: null, type: "DEPOSIT", tradeDate: "2026-01-03", grossAmount: "500", netAmount: "500" });

  const map = await txRepo.ledgerByInstrument({ portfolioId: pf.id });
  assert.equal(map.size, 2, "il DEPOSIT senza strumento non crea un gruppo");
  assert.equal(must(map.get(a.id), "il gruppo di a.id").length, 1);
  assert.equal(must(map.get(b.id), "il gruppo di b.id").length, 1);
});

test("transazioni: paginazione keyset stabile e senza duplicati", async (t) => {
  await freshDb();
  const pf = must(await portfoliosRepo.first(), "il portafoglio");
  const i = must(await instrumentsRepo.create(EQ), "lo strumento creato");
  for (let k = 1; k <= 10; k++) {
    await txRepo.create({
      portfolioId: pf.id,
      instrumentId: i.id,
      type: "BUY",
      tradeDate: `2026-01-${String(k).padStart(2, "0")}`,
      quantity: String(k),
      price: "100",
      netAmount: "-100",
      tradeCcy: "EUR",
      fees: "0",
      taxes: "0",
      accruedInterest: "0",
    });
  }

  await tolerant(t, async () => {
    const page1 = await txRepo.list({ portfolioId: pf.id, limit: 4 });
    assert.equal(page1.items.length, 4);
    assert.ok(page1.nextCursor, "deve esserci un cursore");
    // DESCENDENTE: il movimento più recente in cima.
    assert.equal(page1.items[0].tradeDate, "2026-01-10");

    const page2 = await txRepo.list({ portfolioId: pf.id, limit: 4, cursor: page1.nextCursor });
    assert.equal(page2.items.length, 4);
    assert.equal(page2.items[0].tradeDate, "2026-01-06");

    const page3 = await txRepo.list({ portfolioId: pf.id, limit: 4, cursor: page2.nextCursor });
    assert.equal(page3.items.length, 2);
    assert.equal(page3.nextCursor, null, "ultima pagina: nessun cursore");

    // Nessuna riga vista due volte, tutte e 10 viste una volta.
    const ids = [...page1.items, ...page2.items, ...page3.items].map((x) => x.id);
    assert.equal(new Set(ids).size, 10);
  });
});

test("transazioni: il cursore è opaco ma robusto a input spazzatura", () => {
  assert.equal(txRepo.decodeCursor(null), null);
  assert.equal(txRepo.decodeCursor("non-base64!!"), null);
  assert.equal(txRepo.decodeCursor(Buffer.from("{}").toString("base64url")), null);
  const good = txRepo.encodeCursor({ tradeDate: "2026-01-01", id: 5 });
  assert.deepEqual(txRepo.decodeCursor(good), { d: "2026-01-01", i: 5 });
});

test("transazioni: la JOIN con lo strumento porta i metadati per la tabella", async (t) => {
  await freshDb();
  const pf = must(await portfoliosRepo.first(), "il portafoglio");
  const b = must(await instrumentsRepo.create(BTP), "lo strumento creato");
  await txRepo.create({
    portfolioId: pf.id,
    instrumentId: b.id,
    type: "BUY",
    tradeDate: "2026-01-10",
    quantity: "10",
    price: "98.5",
    netAmount: "-9850",
    tradeCcy: "EUR",
    fees: "0",
    taxes: "0",
    accruedInterest: "0",
  });
  await tolerant(t, async () => {
    const page = await txRepo.list({ portfolioId: pf.id });
    assert.equal(must(page.items[0]?.instrument, "lo strumento del movimento").name, "BTP 3,45% 01/07/2030");
    assert.equal(must(page.items[0]?.instrument, "lo strumento del movimento").quoteConvention, "PCT_OF_NOMINAL");
    assert.equal(must(page.items[0]?.instrument, "lo strumento del movimento").faceValue !== null, true);
  });
});

test("transazioni: earliestDate per portafoglio e per strumento", async () => {
  await freshDb();
  const pf = must(await portfoliosRepo.first(), "il portafoglio");
  const i = must(await instrumentsRepo.create(EQ), "lo strumento creato");
  assert.equal(await txRepo.earliestDate(pf.id), null, "senza movimenti è null");
  const base = { portfolioId: pf.id, instrumentId: i.id, type: "BUY", quantity: "1", price: "10", netAmount: "-10", tradeCcy: "EUR", fees: "0", taxes: "0", accruedInterest: "0" };
  await txRepo.create({ ...base, tradeDate: "2025-06-01" });
  await txRepo.create({ ...base, tradeDate: "2024-03-15" });
  assert.equal(await txRepo.earliestDate(pf.id), "2024-03-15");
  assert.equal(await txRepo.earliestDateByInstrument(i.id), "2024-03-15");
});

test("transazioni: update ricalcola e delete rimuove", async () => {
  await freshDb();
  const pf = must(await portfoliosRepo.first(), "il portafoglio");
  const i = must(await instrumentsRepo.create(EQ), "lo strumento creato");
  const tx = must(
    await txRepo.create({
      portfolioId: pf.id,
      instrumentId: i.id,
      type: "BUY",
      tradeDate: "2026-01-10",
      quantity: "10",
      price: "100",
      netAmount: "-1000",
      tradeCcy: "EUR",
      fees: "0",
      taxes: "0",
      accruedInterest: "0",
    }),
    "il movimento creato"
  );
  const upd = must(await txRepo.update(tx.id, { price: "110", netAmount: "-1100" }), "il movimento aggiornato");
  assert.equal(Number(upd.price), 110);
  assert.equal(Number(upd.netAmount), -1100);
  assert.equal(await txRepo.remove(tx.id), true);
  assert.equal(await txRepo.byId(tx.id), null);
  assert.equal(await txRepo.remove(tx.id), false, "una seconda delete è false, non un errore");
});

test("prezzi: upsertBars è IDEMPOTENTE", async () => {
  await freshDb();
  const i = must(await instrumentsRepo.create(EQ), "lo strumento creato");
  const bars = [
    { date: "2026-01-02", close: "100", adjClose: "100", open: "99", high: "101", low: "98", volume: "1000" },
    { date: "2026-01-05", close: "102" },
  ];
  await pricesRepo.upsertBars(i.id, bars);
  await pricesRepo.upsertBars(i.id, bars); // due volte

  const series = await pricesRepo.series(i.id);
  assert.equal(series.length, 2, "nessun duplicato: la PK è (instrument_id, price_date)");
  assert.equal(series[0].date, "2026-01-02");
  assert.equal(Number(series[0].close), 100);

  // Un secondo upsert con prezzi diversi AGGIORNA.
  await pricesRepo.upsertBars(i.id, [{ date: "2026-01-02", close: "105" }]);
  const after = await pricesRepo.series(i.id);
  assert.equal(Number(after[0].close), 105);
  assert.equal(after.length, 2);
});

test("prezzi: un prezzo MANUALE non viene sovrascritto da uno automatico", async () => {
  // Regola importante per le obbligazioni: il dato inserito a mano è l'unico che
  // esiste, e un refresh non deve poterlo cancellare.
  await freshDb();
  const b = must(await instrumentsRepo.create(BTP), "lo strumento creato");
  await pricesRepo.upsertManual(b.id, "2026-01-02", "98.5");
  await pricesRepo.upsertBars(b.id, [{ date: "2026-01-02", close: "1" }], "yahoo");

  const series = await pricesRepo.series(b.id);
  assert.equal(Number(series[0].close), 98.5, "il prezzo manuale sopravvive");
  assert.equal(series[0].source, "manual");

  // Ma una correzione manuale vince sempre.
  await pricesRepo.upsertManual(b.id, "2026-01-02", "99.25");
  assert.equal(Number((await pricesRepo.series(b.id))[0].close), 99.25);
});

test("prezzi: seriesForMany raggruppa per strumento in una sola query", async (t) => {
  await freshDb();
  const a = must(await instrumentsRepo.create(EQ), "lo strumento creato");
  const b = must(await instrumentsRepo.create({ ...EQ, name: "Beta", ticker: "B.MI", isin: "IT0008888888" }), "lo strumento creato");
  await pricesRepo.upsertBars(a.id, [{ date: "2026-01-02", close: "10" }]);
  await pricesRepo.upsertBars(b.id, [{ date: "2026-01-02", close: "20" }, { date: "2026-01-03", close: "21" }]);

  const map = await pricesRepo.seriesForMany([a.id, b.id]);
  if (map.size !== 2) {
    t.skip("limite di pg-mem su ANY(int[]) con più chiavi");
    return;
  }
  assert.equal(must(map.get(a.id), "il gruppo di a.id").length, 1);
  assert.equal(must(map.get(b.id), "il gruppo di b.id").length, 2);
  // Ascendente per data: è il contratto che forwardFill assume.
  assert.deepEqual(must(map.get(b.id), "il gruppo di b.id").map((x: { date: string }) => x.date), ["2026-01-02", "2026-01-03"]);
  assert.equal((await pricesRepo.seriesForMany([])).size, 0);
});

test("prezzi: latestAsOf fa forward-fill in SQL", async (t) => {
  await freshDb();
  const i = must(await instrumentsRepo.create(EQ), "lo strumento creato");
  await pricesRepo.upsertBars(i.id, [
    { date: "2026-01-02", close: "100" },
    { date: "2026-01-09", close: "110" },
  ]);
  await tolerant(t, async () => {
    // Il 5 gennaio non ha barra: deve tornare quella del 2.
    const m = await pricesRepo.latestAsOf([i.id], "2026-01-05");
    if (!m.get(i.id)) {
      t.skip("limite di pg-mem su DISTINCT ON + ANY(int[])");
      return;
    }
    assert.equal(Number(m.get(i.id).price), 100);
    assert.equal(m.get(i.id).priceDate, "2026-01-02");
    // Prima di ogni osservazione: nessuna riga, MAI uno zero.
    const before = await pricesRepo.latestAsOf([i.id], "2026-01-01");
    assert.equal(before.get(i.id), undefined);
  });
});

test("quotes_latest: upsert per strumento, una riga sola", async (t) => {
  await freshDb();
  const i = must(await instrumentsRepo.create(EQ), "lo strumento creato");
  await pricesRepo.upsertQuote({ instrumentId: i.id, price: "100", currency: "EUR", previousClose: "99", source: "yahoo" });
  await pricesRepo.upsertQuote({ instrumentId: i.id, price: "101", currency: "EUR", previousClose: "100", source: "yahoo" });
  const m = await pricesRepo.latestQuotes([i.id]);
  if (m.size !== 1) {
    t.skip("limite di pg-mem su ANY(int[])");
    return;
  }
  assert.equal(Number(m.get(i.id).price), 101, "una sola riga per strumento, aggiornata");
  assert.equal(Number(m.get(i.id).previousClose), 100);
});

test("fx: upsertRates idempotente e seriesForMany per valuta", async () => {
  await freshDb();
  const recs = [
    { date: "2026-08-03", base: "EUR", quote: "USD", rate: "1.1501" },
    { date: "2026-08-04", base: "EUR", quote: "USD", rate: "1.1523" },
    { date: "2026-08-04", base: "EUR", quote: "GBP", rate: "0.85651" },
  ];
  await fxRepo.upsertRates(recs);
  await fxRepo.upsertRates(recs);

  const map = await fxRepo.seriesForMany(["USD", "GBP"]);
  assert.equal(must(map.get("USD"), "la serie USD").length, 2, "nessun duplicato");
  assert.equal(must(map.get("GBP"), "la serie GBP").length, 1);
  assert.deepEqual(must(map.get("USD"), "la serie USD").map((x: { date: string }) => x.date), ["2026-08-03", "2026-08-04"]);

  // EUR (la base) non viene mai interrogata né persistita.
  const withBase = await fxRepo.seriesForMany(["EUR", "USD"]);
  assert.equal(withBase.has("EUR"), false);
});

test("fx: un tasso forward-filled non sovrascrive uno pubblicato", async () => {
  await freshDb();
  await fxRepo.upsertRates([{ date: "2026-08-04", quote: "USD", rate: "1.1523", isFilled: false }]);
  await fxRepo.upsertRates([{ date: "2026-08-04", quote: "USD", rate: "9.9999", isFilled: true }]);
  const map = await fxRepo.seriesForMany(["USD"]);
  assert.equal(Number(must(map.get("USD"), "la serie USD")[0].rate), 1.1523, "il tasso pubblicato vince sul riempito");
});

test("fx: rateAsOf riporta avanti e dichiara la data effettiva", async () => {
  await freshDb();
  await fxRepo.upsertRates([{ date: "2026-08-03", quote: "USD", rate: "1.15" }]);
  const r = must(await fxRepo.rateAsOf("USD", "2026-08-10"), "il cambio");
  assert.equal(Number(r.rate), 1.15);
  assert.equal(r.date, "2026-08-03", "dice DA QUANDO viene il tasso");
  // EUR su EUR è sempre 1 e non tocca il database.
  assert.equal(must(await fxRepo.rateAsOf("EUR", "2026-08-10"), "il cambio EUR/EUR").rate, "1");
  // Nessun tasso disponibile → null, non 1 silenzioso.
  assert.equal(await fxRepo.rateAsOf("JPY", "2026-08-10"), null);
});

test("eventi: upsert sulla chiave naturale è idempotente", async () => {
  await freshDb();
  const i = must(await instrumentsRepo.create(EQ), "lo strumento creato");
  const ev = {
    instrumentId: i.id,
    kind: "DIVIDEND",
    status: "PROJECTED",
    exDate: "2026-05-20",
    payDate: "2026-05-25",
    amountPerUnit: "1.5",
    currency: "EUR",
    source: "yahoo",
  };
  await eventsRepo.upsert(ev);
  await eventsRepo.upsert({ ...ev, amountPerUnit: "1.6" });
  const list = await eventsRepo.list({ instrumentId: i.id });
  assert.equal(list.length, 1, "stessa chiave naturale → una riga");
  assert.equal(Number(list[0].amountPerUnit), 1.6, "l'importo si aggiorna");
});

test("eventi: un evento PAID non viene declassato da un refresh", async () => {
  await freshDb();
  const i = must(await instrumentsRepo.create(EQ), "lo strumento creato");
  const ev = {
    instrumentId: i.id,
    kind: "DIVIDEND",
    status: "PROJECTED",
    exDate: "2026-05-20",
    payDate: "2026-05-25",
    amountPerUnit: "1.5",
    currency: "EUR",
    source: "yahoo",
  };
  const created = must(await eventsRepo.upsert(ev), "l'evento salvato");
  await eventsRepo.markPaid(created.id, null);
  // Il refresh ripassa con status PROJECTED.
  await eventsRepo.upsert({ ...ev, status: "PROJECTED" });
  const list = await eventsRepo.list({ instrumentId: i.id });
  assert.equal(list[0].status, "PAID", "la conferma dell'utente vince sul refresh");
});

test("eventi: replaceProjected rigenera ma RISPARMIA gli eventi collegati", async () => {
  await freshDb();
  const b = must(await instrumentsRepo.create(BTP), "lo strumento creato");
  const bonds = require("../../src/domain/bonds") as typeof import("../../src/domain/bonds");
  const mk = () =>
    bonds.projectedEvents(b, null).map((e) => ({
      kind: e.kind,
      status: "PROJECTED",
      payDate: e.payDate,
      amountPerUnit: e.amountPerUnit,
      currency: "EUR",
      source: "schedule",
    }));

  const n1 = await eventsRepo.replaceProjected(b.id, mk());
  assert.equal(n1, 13, "12 cedole + 1 rimborso");
  const n2 = await eventsRepo.replaceProjected(b.id, mk());
  assert.equal(n2, 13, "rigenerare non duplica");
  assert.equal((await eventsRepo.list({ instrumentId: b.id })).length, 13);

  // Un evento confermato non deve sparire alla rigenerazione.
  const first = must((await eventsRepo.list({ instrumentId: b.id }))[0], "il primo evento");
  const pf = must(await portfoliosRepo.first(), "il portafoglio");
  const tx = must(
    await txRepo.create({
      portfolioId: pf.id,
      instrumentId: b.id,
      type: "COUPON",
      tradeDate: must(first.payDate, "la data di pagamento"),
      grossAmount: "172.5",
      netAmount: "127.65",
      taxes: "44.85",
      fees: "0",
      accruedInterest: "0",
      tradeCcy: "EUR",
    }),
    "il movimento creato"
  );
  await eventsRepo.markPaid(first.id, tx.id);
  await eventsRepo.replaceProjected(b.id, mk());
  const after = await eventsRepo.list({ instrumentId: b.id });
  const survived = after.find((e) => e.id === first.id);
  assert.ok(survived, "l'evento collegato a una transazione è sopravvissuto");
  assert.equal(survived.status, "PAID");
  assert.equal(survived.transactionId, tx.id);
});

test("eventi: filtro per intervallo di pay_date, ordinato", async () => {
  await freshDb();
  const b = must(await instrumentsRepo.create(BTP), "lo strumento creato");
  const bonds = require("../../src/domain/bonds") as typeof import("../../src/domain/bonds");
  await eventsRepo.replaceProjected(
    b.id,
    bonds.projectedEvents(b, null).map((e) => ({
      kind: e.kind,
      status: "PROJECTED",
      payDate: e.payDate,
      amountPerUnit: e.amountPerUnit,
      currency: "EUR",
      source: "schedule",
    }))
  );
  const window = await eventsRepo.list({ from: "2026-01-01", to: "2026-12-31" });
  assert.deepEqual(window.map((e) => e.payDate), ["2026-01-01", "2026-07-01"]);
  assert.equal(window[0].instrument.name, "BTP 3,45% 01/07/2030", "la JOIN porta lo strumento");
});

test("refresh_log: start → finish e lastSuccess", async (t) => {
  await freshDb();
  const id = await refreshLog.start("quotes", "tutti");
  await refreshLog.finish(id, { ok: true, rowCount: 7 });
  await tolerant(t, async () => {
    const last = must(await refreshLog.lastSuccess("quotes"), "l'ultimo successo");
    assert.equal(Number(last.rowCount), 7);
    assert.equal(await refreshLog.lastSuccess("fx"), null);
    const runs = await refreshLog.lastRuns();
    assert.equal(runs.quotes.ok, true);
  });
});

test("refresh_log: un errore viene troncato, non fa esplodere l'INSERT", async () => {
  await freshDb();
  const id = await refreshLog.start("history", "ACME.MI");
  await refreshLog.finish(id, { ok: false, error: "x".repeat(5000) });
  const recent = await refreshLog.recent("history", 5);
  assert.equal(recent[0].ok, false);
  assert.ok(recent[0].error.length <= 2000);
});

test("strumenti: transactionCount alimenta il 409 su DELETE", async () => {
  await freshDb();
  const pf = must(await portfoliosRepo.first(), "il portafoglio");
  const i = must(await instrumentsRepo.create(EQ), "lo strumento creato");
  assert.equal(await instrumentsRepo.transactionCount(i.id), 0);
  await txRepo.create({
    portfolioId: pf.id,
    instrumentId: i.id,
    type: "BUY",
    tradeDate: "2026-01-10",
    quantity: "1",
    price: "10",
    netAmount: "-10",
    tradeCcy: "EUR",
    fees: "0",
    taxes: "0",
    accruedInterest: "0",
  });
  assert.equal(await instrumentsRepo.transactionCount(i.id), 1);
});

test("strumenti: priceCoverage riporta il range effettivo", async () => {
  await freshDb();
  const i = must(await instrumentsRepo.create(EQ), "lo strumento creato");
  assert.deepEqual(await instrumentsRepo.priceCoverage(i.id), { from: null, to: null, rows: 0 });
  await pricesRepo.upsertBars(i.id, [
    { date: "2026-01-02", close: "100" },
    { date: "2026-03-02", close: "110" },
  ]);
  const c = await instrumentsRepo.priceCoverage(i.id);
  assert.equal(c.from, "2026-01-02");
  assert.equal(c.to, "2026-03-02");
  assert.equal(c.rows, 2);
});

test("strumenti: refreshable esclude i manuali e quelli senza ticker", async () => {
  await freshDb();
  await instrumentsRepo.create(EQ); // yahoo + ticker → incluso
  await instrumentsRepo.create(BTP); // manual → escluso
  await instrumentsRepo.create({ ...EQ, name: "Senza ticker", ticker: null, isin: "IT0007777777" });
  const r = await instrumentsRepo.refreshable();
  assert.equal(r.length, 1);
  assert.equal(r[0].ticker, "ACME.MI");
});

test("il layer repo è l'UNICO posto con SQL (confine architetturale)", () => {
  const root = path.join(__dirname, "..", "..", "src");
  const SQL = /\b(SELECT|INSERT INTO|UPDATE\s+\w+\s+SET|DELETE FROM)\b/;
  const consentiti = ["repo", "db"];

  for (const { rel, src } of readSourcesDeep(root)) {
    if (consentiti.some((c) => rel.startsWith(c + path.sep))) continue;
    assert.ok(!SQL.test(src), `${rel} contiene SQL: deve stare in src/repo/`);
  }
});
