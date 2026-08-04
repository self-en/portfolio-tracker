const test = require("node:test");
const assert = require("node:assert/strict");
const val = require("../../src/domain/valuation");
const pos = require("../../src/domain/positions");
const cal = require("../../src/domain/calendar");

let seq = 0;
function tx(o) {
  return {
    id: o.id ?? ++seq,
    instrument_id: "instrument_id" in o ? o.instrument_id : 1,
    type: o.type,
    trade_date: o.trade_date,
    quantity: o.quantity ?? null,
    price: o.price ?? null,
    gross_amount: o.gross_amount ?? null,
    fees: o.fees ?? "0",
    taxes: o.taxes ?? "0",
    accrued_interest: o.accrued_interest ?? "0",
    net_amount: o.net_amount ?? "0",
    trade_ccy: o.trade_ccy ?? "EUR",
    fx_rate: o.fx_rate ?? null,
    split_ratio: o.split_ratio ?? null,
  };
}
const num = (x) => (x === null ? null : Number(x.toFixed()));

const EQUITY = { id: 1, name: "Acme", assetClass: "EQUITY", currency: "EUR", quoteConvention: "PRICE" };

test("serie del valore: forward-fill attraverso un weekend", () => {
  // Venerdì 2026-01-02 quota 100, poi il mercato è chiuso. Il valore del sabato e
  // della domenica è quello del venerdì, non zero e non interpolato.
  const txs = [tx({ type: "BUY", trade_date: "2026-01-02", quantity: "10", price: "100", net_amount: "-1000" })];
  const r = val.valueSeries({
    dates: cal.eachDay("2026-01-02", "2026-01-05"),
    txsByInstrument: new Map([[1, txs]]),
    instruments: new Map([[1, EQUITY]]),
    pricesByInstrument: new Map([
      [1, [{ date: "2026-01-02", close: "100" }, { date: "2026-01-05", close: "110" }]],
    ]),
  });
  assert.deepEqual(
    r.points.map((p) => [p.date, num(p.value), p.partial]),
    [
      ["2026-01-02", 1000, false],
      ["2026-01-03", 1000, false], // sabato
      ["2026-01-04", 1000, false], // domenica
      ["2026-01-05", 1100, false],
    ]
  );
  assert.deepEqual(r.warnings, []);
});

test("buco PRIMA del primo prezzo → partial:true e warning, NON uno zero silenzioso", () => {
  // Il caso di fallimento peggiore dell'app: se questi punti valessero 0, il
  // grafico mostrerebbe un crollo del portafoglio invece di un buco nei dati.
  const txs = [tx({ type: "BUY", trade_date: "2026-01-01", quantity: "10", price: "100", net_amount: "-1000" })];
  const r = val.valueSeries({
    dates: cal.eachDay("2026-01-01", "2026-01-05"),
    txsByInstrument: new Map([[1, txs]]),
    instruments: new Map([[1, EQUITY]]),
    pricesByInstrument: new Map([[1, [{ date: "2026-01-04", close: "120" }]]]),
  });

  assert.deepEqual(
    r.points.map((p) => p.partial),
    [true, true, true, false, false],
    "i giorni senza prezzo devono essere marcati partial"
  );
  // Il contributo è 0 ma il punto è DICHIARATO incompleto.
  assert.equal(num(r.points[0].value), 0);
  assert.equal(r.points[0].partial, true);
  assert.equal(num(r.points[3].value), 1200);

  const w = r.warnings.find((x) => x.code === "price_missing");
  assert.ok(w, "deve esserci un warning price_missing");
  assert.equal(w.instrumentId, 1);
  assert.equal(w.days, 3);
  assert.equal(w.from, "2026-01-01");
  assert.equal(w.to, "2026-01-03");
});

test("nessuna posizione senza prezzo NON genera warning (evita rumore)", () => {
  // Prima dell'acquisto la quantità è zero: non manca nessun dato.
  const txs = [tx({ type: "BUY", trade_date: "2026-01-04", quantity: "10", price: "100", net_amount: "-1000" })];
  const r = val.valueSeries({
    dates: cal.eachDay("2026-01-01", "2026-01-05"),
    txsByInstrument: new Map([[1, txs]]),
    instruments: new Map([[1, EQUITY]]),
    pricesByInstrument: new Map([[1, [{ date: "2026-01-04", close: "100" }]]]),
  });
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(r.points.map((p) => p.partial), [false, false, false, false, false]);
  assert.deepEqual(r.points.map((p) => num(p.value)), [0, 0, 0, 1000, 1000]);
});

test("SPLIT: la serie del valore NON conta due volte (il close di Yahoo è già aggiustato)", () => {
  // Riproduce il caso AAPL della fixture di Fase 0: acquisto 10 @ 320, split 4:1,
  // titolo fermo. La serie `close` di Yahoo è retro-aggiustata → 80 anche prima
  // dello split. Il valore deve restare PIATTO a 3200.
  const txs = [
    tx({ type: "BUY", trade_date: "2020-06-01", quantity: "10", price: "320", net_amount: "-3200" }),
    tx({ type: "SPLIT", trade_date: "2020-08-31", split_ratio: "4", net_amount: "0" }),
  ];
  const dates = ["2020-06-01", "2020-08-30", "2020-08-31", "2020-09-01"];
  const r = val.valueSeries({
    dates,
    txsByInstrument: new Map([[1, txs]]),
    instruments: new Map([[1, EQUITY]]),
    pricesByInstrument: new Map([[1, dates.map((date) => ({ date, close: "80" }))]]),
  });
  assert.deepEqual(
    r.points.map((p) => num(p.value)),
    [3200, 3200, 3200, 3200],
    "un salto qui significa doppio conteggio dello split"
  );
  // E il carico non cambia mai per uno split.
  assert.deepEqual(r.points.map((p) => num(p.cost)), [3200, 3200, 3200, 3200]);
});

test("conversione FX nella serie: divisione per il tasso EUR→X, con forward-fill", () => {
  const USD = { ...EQUITY, currency: "USD" };
  const txs = [
    tx({ type: "BUY", trade_date: "2026-01-01", quantity: "10", price: "100", trade_ccy: "USD", fx_rate: "1.25", net_amount: "-1000" }),
  ];
  const r = val.valueSeries({
    dates: cal.eachDay("2026-01-01", "2026-01-03"),
    txsByInstrument: new Map([[1, txs]]),
    instruments: new Map([[1, USD]]),
    pricesByInstrument: new Map([[1, [{ date: "2026-01-01", close: "100" }]]]),
    fxByCcy: new Map([[
      "USD",
      [{ date: "2026-01-01", rate: "1.25" }, { date: "2026-01-03", rate: "1.00" }],
    ]]),
  });
  assert.deepEqual(
    r.points.map((p) => num(p.value)),
    [800, 800, 1000], // 1000 USD / 1,25 → poi / 1,00
    "il valore in EUR sale se il dollaro si rafforza"
  );
});

test("FX mancante marca il punto partial come un prezzo mancante", () => {
  const USD = { ...EQUITY, currency: "USD" };
  const txs = [
    tx({ type: "BUY", trade_date: "2026-01-01", quantity: "10", price: "100", trade_ccy: "USD", fx_rate: "1.25", net_amount: "-1000" }),
  ];
  const r = val.valueSeries({
    dates: cal.eachDay("2026-01-01", "2026-01-02"),
    txsByInstrument: new Map([[1, txs]]),
    instruments: new Map([[1, USD]]),
    pricesByInstrument: new Map([[1, [{ date: "2026-01-01", close: "100" }]]]),
    fxByCcy: new Map(), // nessun tasso
  });
  assert.deepEqual(r.points.map((p) => p.partial), [true, true]);
  assert.ok(r.warnings.some((w) => w.code === "fx_missing"));
});

test("più strumenti si sommano, e uno senza prezzo marca solo il totale come partial", () => {
  const txs1 = [tx({ instrument_id: 1, type: "BUY", trade_date: "2026-01-01", quantity: "10", price: "100", net_amount: "-1000" })];
  const txs2 = [tx({ instrument_id: 2, type: "BUY", trade_date: "2026-01-01", quantity: "5", price: "40", net_amount: "-200" })];
  const r = val.valueSeries({
    dates: ["2026-01-01"],
    txsByInstrument: new Map([[1, txs1], [2, txs2]]),
    instruments: new Map([[1, EQUITY], [2, { ...EQUITY, id: 2, name: "Beta" }]]),
    pricesByInstrument: new Map([
      [1, [{ date: "2026-01-01", close: "110" }]],
      [2, []], // nessun prezzo per il secondo
    ]),
  });
  assert.equal(num(r.points[0].value), 1100, "solo lo strumento valorizzato contribuisce");
  assert.equal(r.points[0].partial, true, "ma il punto è dichiarato incompleto");
  assert.equal(num(r.points[0].cost), 1200, "il carico invece è completo");
  const w = r.warnings.find((x) => x.instrumentId === 2);
  assert.ok(w);
  assert.equal(w.instrumentName, "Beta");
});

test("netInvested e pnl sono derivati dai flussi", () => {
  const txs = [
    tx({ type: "BUY", trade_date: "2026-01-01", quantity: "10", price: "100", net_amount: "-1000" }),
  ];
  const built = pos.buildPositions(txs);
  const r = val.valueSeries({
    dates: cal.eachDay("2026-01-01", "2026-01-02"),
    txsByInstrument: new Map([[1, txs]]),
    instruments: new Map([[1, EQUITY]]),
    pricesByInstrument: new Map([[1, [{ date: "2026-01-01", close: "100" }, { date: "2026-01-02", close: "120" }]]]),
    flows: built.flows,
  });
  assert.deepEqual(r.points.map((p) => num(p.netInvested)), [1000, 1000]);
  assert.deepEqual(r.points.map((p) => num(p.pnl)), [0, 200]);
});

test("serie obbligazionaria: valore dal nominale, rateo opzionale", () => {
  const BOND = {
    id: 1,
    name: "BTP 3,45% 2030",
    assetClass: "BOND",
    currency: "EUR",
    quoteConvention: "PCT_OF_NOMINAL",
    faceValue: "1000",
    couponRate: "0.0345",
    couponFrequency: 2,
    firstCouponDate: "2025-01-01",
    maturityDate: "2030-07-01",
    dayCount: "ACT/ACT-ICMA",
  };
  const txs = [
    tx({ type: "BUY", trade_date: "2026-01-01", quantity: "10", price: "98.5", net_amount: "-9850" }),
  ];
  const common = {
    dates: ["2026-04-02"],
    txsByInstrument: new Map([[1, txs]]),
    instruments: new Map([[1, BOND]]),
    pricesByInstrument: new Map([[1, [{ date: "2026-01-01", close: "99" }]]]),
  };

  // Corso SECCO: 10.000 nominali × 0,99 = 9.900.
  const secco = val.valueSeries(common);
  assert.equal(num(secco.points[0].value), 9900);
  assert.equal(num(secco.points[0].accrued) > 0, true, "il rateo è calcolato a parte");

  // Con includeAccrued il rateo entra nel totale (corso tel quel).
  const telQuel = val.valueSeries({ ...common, includeAccrued: true });
  assert.ok(
    num(telQuel.points[0].value) > num(secco.points[0].value),
    "tel quel deve essere superiore al secco"
  );
  // Rateo atteso: 1,725 × 91/181 per 100 di nominale, su 10.000 nominali.
  const expectedAccrued = 10000 * ((1.725 * 91) / 181) / 100;
  assert.ok(Math.abs(num(secco.points[0].accrued) - expectedAccrued) < 0.01);
});

test("serie vuota se non ci sono date", () => {
  const r = val.valueSeries({ dates: [], txsByInstrument: new Map() });
  assert.deepEqual(r.points, []);
  assert.deepEqual(r.warnings, []);
});

// ---------------------------------------------------------------------------
// valuePositions
// ---------------------------------------------------------------------------

test("valuePositions calcola totali, pesi e variazione giornaliera", () => {
  const txs = [
    tx({ instrument_id: 1, type: "BUY", trade_date: "2026-01-01", quantity: "10", price: "100", net_amount: "-1000" }),
    tx({ instrument_id: 2, type: "BUY", trade_date: "2026-01-01", quantity: "10", price: "50", net_amount: "-500" }),
  ];
  const instruments = new Map([
    [1, EQUITY],
    [2, { ...EQUITY, id: 2, name: "Beta" }],
  ]);
  const built = pos.buildPositions(txs, { instruments });
  const r = val.valuePositions({
    asOf: "2026-06-01",
    built,
    instruments,
    quotes: new Map([
      [1, { price: "120", previousClose: "118" }],
      [2, { price: "45", previousClose: "45" }],
    ]),
  });

  assert.equal(num(r.totals.marketValue), 1650); // 1200 + 450
  assert.equal(num(r.totals.costBasis), 1500);
  assert.equal(num(r.totals.unrealizedPnl), 150);
  assert.equal(num(r.totals.dayChange), 20); // (120-118)×10 + 0
  const a = r.rows.find((x) => x.instrumentId === 1);
  assert.ok(Math.abs(num(a.weight) - 1200 / 1650) < 1e-9);
  // I pesi sommano a 1.
  assert.ok(Math.abs(r.rows.reduce((s, x) => s + num(x.weight), 0) - 1) < 1e-9);
});

test("valuePositions: realizzato, redditi e latente restano TRE VOCI SEPARATE", () => {
  // Requisito di docs/decisions.md §3: non vengono mai sommati in un unico
  // "profitto", perché il trattamento fiscale italiano differisce per involucro.
  const txs = [
    tx({ type: "BUY", trade_date: "2026-01-01", quantity: "20", price: "100", net_amount: "-2000" }),
    tx({ type: "SELL", trade_date: "2026-03-01", quantity: "10", price: "130", net_amount: "1300" }),
    tx({ type: "DIVIDEND", trade_date: "2026-05-01", gross_amount: "80", taxes: "20.8", net_amount: "59.2" }),
  ];
  const instruments = new Map([[1, EQUITY]]);
  const built = pos.buildPositions(txs, { instruments });
  const r = val.valuePositions({
    asOf: "2026-06-01",
    built,
    instruments,
    quotes: new Map([[1, { price: "140" }]]),
  });

  assert.equal(num(r.totals.realizedPnl), 300); // 1300 - 1000
  assert.equal(num(r.totals.incomeGross), 80);
  assert.equal(num(r.totals.taxWithheld), 20.8);
  assert.equal(num(r.totals.incomeNet), 59.2);
  assert.equal(num(r.totals.marketValue), 1400); // 10 × 140
  assert.equal(num(r.totals.unrealizedPnl), 400); // 1400 - 1000
  // Nessun campo "profitto totale": è deliberato.
  assert.equal(r.totals.totalProfit, undefined);
});

test("valuePositions senza quotazione: warning e valore null, non zero", () => {
  const txs = [tx({ type: "BUY", trade_date: "2026-01-01", quantity: "10", price: "100", net_amount: "-1000" })];
  const instruments = new Map([[1, EQUITY]]);
  const built = pos.buildPositions(txs, { instruments });
  const r = val.valuePositions({ asOf: "2026-06-01", built, instruments, quotes: new Map() });
  assert.equal(r.rows[0].marketValueBase, null);
  assert.equal(r.rows[0].priced, false);
  assert.equal(num(r.totals.marketValue), 0);
  assert.ok(r.warnings.some((w) => w.code === "price_missing"));
});

test("valuePositions: una posizione CHIUSA senza quotazione non genera warning", () => {
  const txs = [
    tx({ type: "BUY", trade_date: "2026-01-01", quantity: "10", price: "100", net_amount: "-1000" }),
    tx({ type: "SELL", trade_date: "2026-02-01", quantity: "10", price: "110", net_amount: "1100" }),
  ];
  const instruments = new Map([[1, EQUITY]]);
  const built = pos.buildPositions(txs, { instruments });
  const r = val.valuePositions({ asOf: "2026-06-01", built, instruments, quotes: new Map() });
  assert.equal(num(r.rows[0].quantity), 0);
  assert.equal(num(r.totals.realizedPnl), 100);
  assert.deepEqual(r.warnings, [], "niente da valorizzare, niente da segnalare");
});

test("valuePositions: cambio mancante su valuta estera → warning, non conversione 1:1", () => {
  // Senza warning, una posizione in USD verrebbe sommata al totale in EUR come se il
  // cambio fosse 1 — un errore del 15% che non somiglia a un errore.
  const USD = { ...EQUITY, currency: "USD" };
  const txs = [
    tx({ type: "BUY", trade_date: "2026-01-01", quantity: "10", price: "100", trade_ccy: "USD", fx_rate: "1.25", net_amount: "-1000" }),
  ];
  const instruments = new Map([[1, USD]]);
  const built = pos.buildPositions(txs, { instruments });
  const r = val.valuePositions({
    asOf: "2026-06-01",
    built,
    instruments,
    quotes: new Map([[1, { price: "110" }]]),
    fxRates: new Map(), // nessun cambio disponibile
  });
  const w = r.warnings.find((x) => x.code === "fx_missing");
  assert.ok(w, "deve segnalare il cambio mancante");
  assert.equal(w.currency, "USD");
  assert.equal(w.instrumentId, 1);
});

test("valuePositions: il rateo obbligazionario entra nei totali solo con includeAccrued", () => {
  const BOND = {
    id: 1,
    name: "BTP",
    assetClass: "BOND",
    currency: "EUR",
    quoteConvention: "PCT_OF_NOMINAL",
    faceValue: "1000",
    couponRate: "0.0345",
    couponFrequency: 2,
    firstCouponDate: "2025-01-01",
    maturityDate: "2030-07-01",
    dayCount: "ACT/ACT-ICMA",
  };
  const txs = [
    tx({ type: "BUY", trade_date: "2026-01-01", quantity: "10", price: "98.5", net_amount: "-9850" }),
  ];
  const instruments = new Map([[1, BOND]]);
  const built = pos.buildPositions(txs, { instruments });
  const args = {
    asOf: "2026-04-02",
    built,
    instruments,
    quotes: new Map([[1, { price: "99" }]]),
  };

  const secco = val.valuePositions(args);
  const telQuel = val.valuePositions({ ...args, includeAccrued: true });

  // Il rateo è SEMPRE calcolato e riportato a parte…
  assert.ok(num(secco.totals.accruedInterest) > 0);
  assert.equal(num(secco.rows[0].accruedInterest), num(secco.totals.accruedInterest));
  // …ma entra nel totale solo su richiesta (corso tel quel invece che secco).
  assert.equal(num(secco.totals.totalValue), num(secco.totals.marketValue));
  assert.equal(
    num(telQuel.totals.totalValue),
    num(telQuel.totals.marketValue) + num(telQuel.totals.accruedInterest)
  );
});

test("allocate raggruppa e pesa, ordinando per valore decrescente", () => {
  const txs = [
    tx({ instrument_id: 1, type: "BUY", trade_date: "2026-01-01", quantity: "10", price: "100", net_amount: "-1000" }),
    tx({ instrument_id: 2, type: "BUY", trade_date: "2026-01-01", quantity: "10", price: "50", net_amount: "-500" }),
    tx({ instrument_id: 3, type: "BUY", trade_date: "2026-01-01", quantity: "10", price: "30", net_amount: "-300" }),
  ];
  const instruments = new Map([
    [1, { ...EQUITY, assetClass: "ETF" }],
    [2, { ...EQUITY, id: 2, assetClass: "ETF" }],
    [3, { ...EQUITY, id: 3, assetClass: "EQUITY" }],
  ]);
  const built = pos.buildPositions(txs, { instruments });
  const r = val.valuePositions({
    asOf: "2026-06-01",
    built,
    instruments,
    quotes: new Map([
      [1, { price: "100" }],
      [2, { price: "50" }],
      [3, { price: "30" }],
    ]),
  });
  const byClass = val.allocate(r.rows, (x) => x.instrument.assetClass);
  assert.equal(byClass[0].key, "ETF");
  assert.equal(num(byClass[0].marketValue), 1500);
  assert.equal(num(byClass[1].marketValue), 300);
  assert.ok(Math.abs(num(byClass[0].weight) - 1500 / 1800) < 1e-9);
  assert.ok(Math.abs(byClass.reduce((s, g) => s + num(g.weight), 0) - 1) < 1e-9);
});

test("allocate con totale zero non produce NaN", () => {
  const rows = [{ marketValueBase: null, instrument: { assetClass: "ETF" } }];
  const out = val.allocate(rows, (x) => x.instrument.assetClass);
  assert.deepEqual(out, []);
});
