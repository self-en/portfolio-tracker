import test from "node:test";
import assert from "node:assert/strict";
import * as pos from "../../src/domain/positions";
import { must } from "../helpers/must";
import type { TxSpec } from "../helpers/txSpec";
import type Decimal from "decimal.js";

let seq = 0;

/** Helper: costruisce una transazione con i default sensati. */
function tx(o: TxSpec) {
  return {
    id: o.id ?? ++seq,
    portfolio_id: 1,
    // `??` non basta: un instrument_id esplicitamente null (DEPOSIT/WITHDRAWAL)
    // deve restare null, non ricadere sul default.
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

const P = (r: ReturnType<typeof pos.buildPositions>, id = 1) => r.positions.get(id);

/**
 * Il valore decimale come number, per confrontarlo con un letterale.
 *
 * Accetta anche null perché molti campi valorizzati lo sono quando manca il
 * prezzo, e `must` fa fallire il test dicendo QUALE valore mancava invece di
 * lasciare un "cannot read properties of null" senza nome.
 */
const num = (dec: Decimal | null | undefined) => Number(must(dec, "il valore decimale").toFixed());

test("acquisto/acquisto/vendita con COSTO MEDIO PONDERATO", () => {
  // 10 @ 100 (comm 5) → carico 1005; 10 @ 120 (comm 5) → carico 2210
  // costo medio = 110,50. Vendita 10 @ 130 (comm 5) → incasso 1295
  // realizzato = 1295 - 1105 = 190. Residuo: 10 pezzi, carico 1105.
  const r = pos.buildPositions([
    tx({ type: "BUY", trade_date: "2026-01-10", quantity: "10", price: "100", fees: "5", net_amount: "-1005" }),
    tx({ type: "BUY", trade_date: "2026-02-10", quantity: "10", price: "120", fees: "5", net_amount: "-1205" }),
    tx({ type: "SELL", trade_date: "2026-03-10", quantity: "10", price: "130", fees: "5", net_amount: "1295" }),
  ]);
  const p = P(r);
  assert.equal(num(p.quantity), 10);
  assert.equal(num(p.costBasis), 1105);
  assert.equal(num(p.realizedPnl), 190);
  assert.deepEqual(r.warnings, []);
});

test("vendita totale → quantità 0, carico 0, realizzato esatto", () => {
  const r = pos.buildPositions([
    tx({ type: "BUY", trade_date: "2026-01-10", quantity: "10", price: "100", fees: "5", net_amount: "-1005" }),
    tx({ type: "SELL", trade_date: "2026-06-10", quantity: "10", price: "150", fees: "5", net_amount: "1495" }),
  ]);
  const p = P(r);
  assert.equal(num(p.quantity), 0);
  assert.equal(num(p.costBasis), 0, "il carico deve azzerarsi, non lasciare residui");
  assert.equal(num(p.realizedPnl), 490); // 1495 - 1005
});

test("le commissioni di ACQUISTO entrano nel carico (prassi italiana)", () => {
  const senza = pos.buildPositions([
    tx({ type: "BUY", trade_date: "2026-01-10", quantity: "10", price: "100", fees: "0", net_amount: "-1000" }),
  ]);
  const con = pos.buildPositions([
    tx({ type: "BUY", trade_date: "2026-01-10", quantity: "10", price: "100", fees: "7.5", net_amount: "-1007.5" }),
  ]);
  assert.equal(num(P(senza).costBasis), 1000);
  assert.equal(num(P(con).costBasis), 1007.5);
});

test("split 2-per-1 poi vendita: il carico non cambia, il costo medio si dimezza", () => {
  // 10 @ 100 = 1000. Split 2:1 → 20 pezzi, carico ancora 1000, medio 50.
  // Vendita 20 @ 60 = 1200 → realizzato 200.
  const r = pos.buildPositions([
    tx({ type: "BUY", trade_date: "2026-01-10", quantity: "10", price: "100", net_amount: "-1000" }),
    tx({ type: "SPLIT", trade_date: "2026-02-01", split_ratio: "2", net_amount: "0" }),
  ]);
  const p = P(r);
  assert.equal(num(p.quantity), 20);
  assert.equal(num(p.costBasis), 1000, "lo split non crea né distrugge carico");

  const r2 = pos.buildPositions([
    tx({ type: "BUY", trade_date: "2026-01-10", quantity: "10", price: "100", net_amount: "-1000" }),
    tx({ type: "SPLIT", trade_date: "2026-02-01", split_ratio: "2", net_amount: "0" }),
    tx({ type: "SELL", trade_date: "2026-03-01", quantity: "20", price: "60", net_amount: "1200" }),
  ]);
  assert.equal(num(P(r2).quantity), 0);
  assert.equal(num(P(r2).realizedPnl), 200);
});

test("OVERSELL → clamp + warning, mai una quantità negativa", () => {
  const r = pos.buildPositions([
    tx({ type: "BUY", trade_date: "2026-01-10", quantity: "10", price: "100", net_amount: "-1000" }),
    tx({ id: 99, type: "SELL", trade_date: "2026-02-10", quantity: "15", price: "110", net_amount: "1650" }),
  ]);
  const p = P(r);
  assert.equal(num(p.quantity), 0, "clampata a zero, NON -5");
  assert.ok(p.quantity.gte(0));
  const w = r.warnings.find((x) => x.code === "oversell");
  assert.ok(w, "deve esserci un warning di oversell");
  assert.equal(w.txId, 99);
  assert.equal(w.instrumentId, 1);
  assert.equal(w.requested, "15");
  assert.equal(w.available, "10");
  // Il warning si propaga anche sulla posizione, per il badge in UI.
  assert.equal(p.warnings.length, 1);
  // L'incasso reale resta quello: 1650 di proventi contro 1000 di carico.
  assert.equal(num(p.realizedPnl), 650);
});

test("multivaluta con fx fisso: conversione per DIVISIONE (EUR→X)", () => {
  // 10 @ 100 USD con EURUSD 1,25 → 1000 USD / 1,25 = 800 EUR.
  const r = pos.buildPositions([
    tx({
      type: "BUY",
      trade_date: "2026-01-10",
      quantity: "10",
      price: "100",
      trade_ccy: "USD",
      fx_rate: "1.25",
      net_amount: "-1000",
    }),
  ]);
  assert.equal(num(P(r).costBasis), 800);
});

test("multivaluta: le commissioni sono convertite come il resto", () => {
  const r = pos.buildPositions([
    tx({
      type: "BUY",
      trade_date: "2026-01-10",
      quantity: "10",
      price: "100",
      fees: "10",
      trade_ccy: "USD",
      fx_rate: "1.25",
      net_amount: "-1010",
    }),
  ]);
  assert.equal(num(P(r).costBasis), 808); // (1000 + 10) / 1,25
});

test("fx assente → warning, non un tasso inventato in silenzio", () => {
  const r = pos.buildPositions([
    tx({ type: "BUY", trade_date: "2026-01-10", quantity: "10", price: "100", trade_ccy: "USD", net_amount: "-1000" }),
  ]);
  const w = r.warnings.find((x) => x.code === "fx_missing");
  assert.ok(w);
  assert.equal(w.currency, "USD");
  assert.equal(w.date, "2026-01-10");
});

test("fxLookup fornisce il tasso quando la transazione non lo porta", () => {
  const r = pos.buildPositions(
    [tx({ type: "BUY", trade_date: "2026-01-10", quantity: "10", price: "100", trade_ccy: "USD", net_amount: "-1000" })],
    { fxLookup: (ccy, date) => (ccy === "USD" && date === "2026-01-10" ? "2" : null) }
  );
  assert.equal(num(P(r).costBasis), 500);
  assert.deepEqual(r.warnings, []);
});

test("acquisto bond: RATEO ESCLUSO dal carico, prezzo in % del nominale", () => {
  // 10 titoli da 1000 nominali (= 10.000 nominali) al 98,5 = 9.850, più 120 di
  // rateo e 8 di commissioni. Carico = 9.850 + 8 = 9.858. Il rateo NON entra.
  const instruments = new Map([
    [1, { id: 1, quoteConvention: "PCT_OF_NOMINAL", faceValue: "1000", currency: "EUR" }],
  ]);
  const r = pos.buildPositions(
    [
      tx({
        type: "BUY",
        trade_date: "2026-01-10",
        quantity: "10",
        price: "98.5",
        fees: "8",
        accrued_interest: "120",
        net_amount: "-9978",
      }),
    ],
    { instruments }
  );
  const p = P(r);
  assert.equal(num(p.costBasis), 9858, "il rateo pagato non è capitalizzato");
  assert.equal(num(p.accruedPaid), 120, "ed è tracciato a parte");
});

test("bond senza faceValue non viene trattato come % del nominale", () => {
  // Senza metadati dello strumento, prezzo × quantità: nessuna moltiplicazione
  // fantasma per 1000.
  const r = pos.buildPositions([
    tx({ type: "BUY", trade_date: "2026-01-10", quantity: "10", price: "98.5", net_amount: "-985" }),
  ]);
  assert.equal(num(P(r).costBasis), 985);
});

test("dividendo lordo con ritenuta → incomeGross / taxWithheld / incomeNet", () => {
  // 100 lordi, 26 di ritenuta → 74 netti. Quantità e carico intatti.
  const r = pos.buildPositions([
    tx({ type: "BUY", trade_date: "2026-01-10", quantity: "100", price: "10", net_amount: "-1000" }),
    tx({
      type: "DIVIDEND",
      trade_date: "2026-05-20",
      gross_amount: "100",
      taxes: "26",
      net_amount: "74",
    }),
  ]);
  const p = P(r);
  assert.equal(num(p.incomeGross), 100);
  assert.equal(num(p.taxWithheld), 26);
  assert.equal(num(p.quantity), 100, "un dividendo non muove la quantità");
  assert.equal(num(p.costBasis), 1000, "né il carico");

  const v = pos.valuePosition(p, null, "12", "1");
  assert.equal(num(v.incomeNet), 74);
});

test("cedola in valuta estera: lordo e ritenuta entrambi convertiti", () => {
  const r = pos.buildPositions([
    tx({
      type: "COUPON",
      trade_date: "2026-05-20",
      gross_amount: "200",
      taxes: "50",
      net_amount: "150",
      trade_ccy: "USD",
      fx_rate: "2",
    }),
  ]);
  const p = P(r);
  assert.equal(num(p.incomeGross), 100);
  assert.equal(num(p.taxWithheld), 25);
});

test("RETURN_OF_CAPITAL riduce il carico, l'eccedenza va nel realizzato", () => {
  const r = pos.buildPositions([
    tx({ type: "BUY", trade_date: "2026-01-10", quantity: "10", price: "100", net_amount: "-1000" }),
    tx({ type: "RETURN_OF_CAPITAL", trade_date: "2026-06-01", net_amount: "300" }),
  ]);
  assert.equal(num(P(r).costBasis), 700);
  assert.equal(num(P(r).realizedPnl), 0);

  // Rimborso superiore al carico: il carico si ferma a zero e il resto è plusvalenza.
  const r2 = pos.buildPositions([
    tx({ type: "BUY", trade_date: "2026-01-10", quantity: "10", price: "100", net_amount: "-1000" }),
    tx({ type: "RETURN_OF_CAPITAL", trade_date: "2026-06-01", net_amount: "1200" }),
  ]);
  assert.equal(num(P(r2).costBasis), 0, "il carico non può essere negativo");
  assert.equal(num(P(r2).realizedPnl), 200);
});

test("FEE e TAX standalone NON sono capitalizzate nel carico", () => {
  const r = pos.buildPositions([
    tx({ type: "BUY", trade_date: "2026-01-10", quantity: "10", price: "100", net_amount: "-1000" }),
    tx({ type: "FEE", trade_date: "2026-02-01", net_amount: "-15" }),
    tx({ type: "TAX", trade_date: "2026-03-01", net_amount: "-25" }),
  ]);
  const p = P(r);
  assert.equal(num(p.costBasis), 1000, "una commissione di custodia non aumenta il carico");
  assert.equal(num(p.feesTotal), 15);
  assert.equal(num(p.taxesTotal), 25);
});

test("il ledger di cassa si ricava gratis, per valuta", () => {
  const r = pos.buildPositions([
    tx({ type: "DEPOSIT", instrument_id: null, trade_date: "2026-01-01", net_amount: "5000" }),
    tx({ type: "BUY", trade_date: "2026-01-10", quantity: "10", price: "100", net_amount: "-1000" }),
    tx({ type: "DIVIDEND", trade_date: "2026-05-20", gross_amount: "100", taxes: "26", net_amount: "74" }),
    tx({ type: "BUY", instrument_id: 2, trade_date: "2026-02-01", quantity: "5", price: "20", trade_ccy: "USD", fx_rate: "1.1", net_amount: "-100" }),
  ]);
  assert.equal(num(r.cash.EUR), 4074); // 5000 - 1000 + 74
  assert.equal(num(r.cash.USD), -100);
});

test("DEPOSIT/WITHDRAWAL non creano posizioni né flussi di investimento", () => {
  const r = pos.buildPositions([
    tx({ type: "DEPOSIT", instrument_id: null, trade_date: "2026-01-01", net_amount: "5000" }),
    tx({ type: "WITHDRAWAL", instrument_id: null, trade_date: "2026-02-01", net_amount: "-2000" }),
  ]);
  assert.equal(r.positions.size, 0);
  assert.equal(r.flows.length, 0, "i movimenti di sola cassa non sono flussi esterni");
  assert.equal(num(r.cash.EUR), 3000);
});

test("l'ordinamento è deterministico: (trade_date, id) in pari data", () => {
  // Due operazioni lo stesso giorno: l'id decide, non l'ordine di input.
  const a = tx({ id: 1, type: "BUY", trade_date: "2026-01-10", quantity: "10", price: "100", net_amount: "-1000" });
  const b = tx({ id: 2, type: "SELL", trade_date: "2026-01-10", quantity: "10", price: "110", net_amount: "1100" });
  const forward = pos.buildPositions([a, b]);
  const backward = pos.buildPositions([b, a]);
  assert.equal(num(P(forward).realizedPnl), 100);
  assert.equal(
    num(P(backward).realizedPnl),
    num(P(forward).realizedPnl),
    "l'ordine di input non deve cambiare il risultato"
  );
  assert.deepEqual(backward.warnings, [], "e non deve generare un falso oversell");
});

test("asOf ignora le transazioni successive", () => {
  const txs = [
    tx({ type: "BUY", trade_date: "2026-01-10", quantity: "10", price: "100", net_amount: "-1000" }),
    tx({ type: "BUY", trade_date: "2026-06-10", quantity: "10", price: "200", net_amount: "-2000" }),
  ];
  assert.equal(num(P(pos.buildPositions(txs, { asOf: "2026-03-01" })).quantity), 10);
  assert.equal(num(P(pos.buildPositions(txs, { asOf: "2026-12-31" })).quantity), 20);
});

test("un metodo di costo non supportato lancia invece di calcolare male", () => {
  // Il cast è il punto: "FIFO" non è un metodo che il tipo ammette, e serve
  // proprio verificare che a runtime venga RIFIUTATO invece di calcolato a media.
  assert.throws(() => pos.buildPositions([], { method: "FIFO" as "AVERAGE" }), /FIFO/);
});

test("più strumenti restano separati", () => {
  const r = pos.buildPositions([
    tx({ instrument_id: 1, type: "BUY", trade_date: "2026-01-10", quantity: "10", price: "100", net_amount: "-1000" }),
    tx({ instrument_id: 2, type: "BUY", trade_date: "2026-01-10", quantity: "5", price: "50", net_amount: "-250" }),
  ]);
  assert.equal(r.positions.size, 2);
  assert.equal(num(P(r, 1).costBasis), 1000);
  assert.equal(num(P(r, 2).costBasis), 250);
});

// ---------------------------------------------------------------------------
// La trappola degli split — §3.4
// ---------------------------------------------------------------------------

test("splitAdjustedQuantitySeries riporta le quantità storiche in quote ODIERNE", () => {
  // Acquisto 10 il 2026-01-10, split 2:1 il 2026-02-01.
  // La serie `close` di Yahoo è GIÀ retro-aggiustata: prima dello split mostra il
  // prezzo dimezzato. Quindi la quantità storica va raddoppiata per corrispondere.
  const txs = [
    tx({ type: "BUY", trade_date: "2026-01-10", quantity: "10", price: "100", net_amount: "-1000" }),
    tx({ type: "SPLIT", trade_date: "2026-02-01", split_ratio: "2", net_amount: "0" }),
  ];
  const dates = ["2026-01-09", "2026-01-10", "2026-01-31", "2026-02-01", "2026-03-01"];
  const s = pos.splitAdjustedQuantitySeries(txs, dates);
  assert.deepEqual(
    s.map((x) => [x.date, num(x.quantity), num(x.raw)]),
    [
      ["2026-01-09", 0, 0],
      ["2026-01-10", 20, 10], // 10 come transate → 20 in quote odierne
      ["2026-01-31", 20, 10],
      ["2026-02-01", 20, 20], // dopo lo split le due coincidono
      ["2026-03-01", 20, 20],
    ]
  );
});

test("NESSUN DOPPIO CONTEGGIO: qtyAdj × closeAggiustato è costante attraverso lo split", () => {
  // È IL test che protegge dal bug più subdolo dell'app. Un titolo che non si
  // muove, con uno split 4:1 in mezzo: il valore di mercato deve restare piatto.
  const txs = [
    tx({ type: "BUY", trade_date: "2020-06-01", quantity: "10", price: "320", net_amount: "-3200" }),
    tx({ type: "SPLIT", trade_date: "2020-08-31", split_ratio: "4", net_amount: "0" }),
  ];
  const dates = ["2020-06-01", "2020-08-30", "2020-08-31", "2020-09-01"];
  const s = pos.splitAdjustedQuantitySeries(txs, dates);
  // Serie close come la restituisce Yahoo: retro-aggiustata, quindi 80 anche
  // PRIMA dello split, quando il titolo scambiava davvero a 320.
  const adjustedClose: Record<string, number> = {
    "2020-06-01": 80,
    "2020-08-30": 80,
    "2020-08-31": 80,
    "2020-09-01": 80,
  };
  const values = s.map((x) => num(x.quantity) * adjustedClose[x.date]);
  assert.deepEqual(values, [3200, 3200, 3200, 3200], "il valore non deve saltare sullo split");
});

test("split multipli si compongono", () => {
  const txs = [
    tx({ type: "BUY", trade_date: "2026-01-01", quantity: "10", price: "100", net_amount: "-1000" }),
    tx({ type: "SPLIT", trade_date: "2026-02-01", split_ratio: "2", net_amount: "0" }),
    tx({ type: "SPLIT", trade_date: "2026-03-01", split_ratio: "3", net_amount: "0" }),
  ];
  const s = pos.splitAdjustedQuantitySeries(txs, ["2026-01-01", "2026-02-01", "2026-03-01"]);
  assert.deepEqual(s.map((x) => num(x.quantity)), [60, 60, 60]);
  assert.deepEqual(s.map((x) => num(x.raw)), [10, 20, 60]);
});

test("uno split inverso (ratio < 1) riduce la quantità", () => {
  const txs = [
    tx({ type: "BUY", trade_date: "2026-01-01", quantity: "100", price: "1", net_amount: "-100" }),
    tx({ type: "SPLIT", trade_date: "2026-02-01", split_ratio: "0.1", net_amount: "0" }),
  ];
  const r = pos.buildPositions(txs);
  assert.equal(num(P(r).quantity), 10);
  assert.equal(num(P(r).costBasis), 100, "il carico resta invariato anche in un raggruppamento");
});

test("uno split_ratio non valido produce un warning e viene ignorato", () => {
  const r = pos.buildPositions([
    tx({ type: "BUY", trade_date: "2026-01-01", quantity: "10", price: "100", net_amount: "-1000" }),
    tx({ type: "SPLIT", trade_date: "2026-02-01", split_ratio: "0", net_amount: "0" }),
  ]);
  assert.equal(num(P(r).quantity), 10);
  assert.ok(r.warnings.some((w) => w.code === "invalid_split"));
});

test("costSeries segue il carico nel tempo", () => {
  const txs = [
    tx({ type: "BUY", trade_date: "2026-01-10", quantity: "10", price: "100", fees: "5", net_amount: "-1005" }),
    tx({ type: "BUY", trade_date: "2026-02-10", quantity: "10", price: "120", fees: "5", net_amount: "-1205" }),
    tx({ type: "SELL", trade_date: "2026-03-10", quantity: "10", price: "130", fees: "5", net_amount: "1295" }),
  ];
  const s = pos.costSeries(txs, ["2026-01-09", "2026-01-10", "2026-02-10", "2026-03-10"]);
  assert.deepEqual(s.map((x) => num(x.cost)), [0, 1005, 2210, 1105]);
});

test("valuePosition calcola latente, percentuale e variazione giornaliera", () => {
  const r = pos.buildPositions([
    tx({ type: "BUY", trade_date: "2026-01-10", quantity: "10", price: "100", net_amount: "-1000" }),
  ]);
  const v = pos.valuePosition(P(r), null, "120", "1", { previousClose: "115" });
  assert.equal(num(v.marketValueBase), 1200);
  assert.equal(num(v.unrealizedPnl), 200);
  assert.equal(num(v.unrealizedPnlPct), 0.2);
  assert.equal(num(v.avgCost), 100);
  assert.equal(num(v.dayChange), 50); // (120 - 115) × 10
  assert.equal(v.priced, true);
});

test("valuePosition senza prezzo: priced=false, nessuno zero silenzioso", () => {
  const r = pos.buildPositions([
    tx({ type: "BUY", trade_date: "2026-01-10", quantity: "10", price: "100", net_amount: "-1000" }),
  ]);
  const v = pos.valuePosition(P(r), null, null, "1");
  assert.equal(v.priced, false);
  assert.equal(v.marketValueBase, null, "null, NON 0: uno zero sembrerebbe un crollo");
  assert.equal(v.unrealizedPnl, null);
});

test("valuePosition converte in valuta base per divisione", () => {
  const r = pos.buildPositions([
    tx({ type: "BUY", trade_date: "2026-01-10", quantity: "10", price: "100", trade_ccy: "USD", fx_rate: "1.25", net_amount: "-1000" }),
  ]);
  const v = pos.valuePosition(P(r), null, "110", "1.25");
  assert.equal(num(v.marketValueLocal), 1100);
  assert.equal(num(v.marketValueBase), 880); // 1100 / 1,25
  assert.equal(num(v.unrealizedPnl), 80); // 880 - 800
});

test("valuePosition su un bond usa il nominale", () => {
  const inst = { id: 1, quoteConvention: "PCT_OF_NOMINAL", faceValue: "1000" };
  const r = pos.buildPositions(
    [tx({ type: "BUY", trade_date: "2026-01-10", quantity: "10", price: "98.5", net_amount: "-9850" })],
    { instruments: new Map([[1, inst]]) }
  );
  const v = pos.valuePosition(P(r), inst, "101.25", "1");
  assert.equal(num(v.marketValueBase), 10125); // 10.000 nominali × 1,0125
  assert.equal(num(v.unrealizedPnl), 275);
});

// ---------------------------------------------------------------------------
// Tenuta su volume
// ---------------------------------------------------------------------------

test("2000 transazioni: nessuna deriva di arrotondamento sul carico", () => {
  // Il caso che i float sbaglierebbero: 0,1 sommato 2000 volte.
  const txs = [];
  for (let i = 0; i < 2000; i++) {
    txs.push(
      tx({
        id: i + 1,
        type: "BUY",
        trade_date: "2026-01-01",
        quantity: "1",
        price: "0.1",
        net_amount: "-0.1",
      })
    );
  }
  const r = pos.buildPositions(txs);
  const p = P(r);
  assert.equal(p.quantity.toFixed(), "2000");
  // Esattamente 200, non 199.99999999999983 come farebbe la somma float.
  assert.equal(p.costBasis.toFixed(), "200");
  assert.equal(p.costBasis.div(p.quantity).toFixed(), "0.1");
});
