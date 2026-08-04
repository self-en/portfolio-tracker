// computeAmounts: la matematica dietro POST /transactions e /transactions/preview.
// Pura, quindi testabile direttamente — ed è lo stesso codice per entrambi gli
// endpoint, che è ciò che garantisce che l'anteprima mostri quello che verrà scritto.
const test = require("node:test");
const assert = require("node:assert/strict");
const { computeAmounts } = require("../../src/domain/txAmounts");

const EQ = { quoteConvention: "PRICE", assetClass: "EQUITY", currency: "EUR" };
const BOND = {
  quoteConvention: "PCT_OF_NOMINAL",
  assetClass: "BOND",
  currency: "EUR",
  faceValue: "1000",
  couponRate: "0.0345",
  couponFrequency: 2,
  firstCouponDate: "2025-01-01",
  maturityDate: "2030-07-01",
  dayCount: "ACT/ACT-ICMA",
};

const n = (s) => Number(s);

test("BUY azionario: netto = lordo + commissioni + imposte, con segno negativo", () => {
  const r = computeAmounts(
    { type: "BUY", tradeDate: "2026-08-04", quantity: "10", price: "127.32", fees: "5", taxes: "0" },
    EQ
  );
  assert.equal(n(r.grossAmount), 1273.2);
  assert.equal(n(r.netAmount), -1278.2);
  assert.equal(n(r.accruedInterest), 0);
  assert.equal(r.nominal, null, "un'azione non ha nominale");
  assert.deepEqual(r.warnings, []);
});

test("SELL azionario: netto = lordo - commissioni - imposte, positivo", () => {
  const r = computeAmounts(
    { type: "SELL", tradeDate: "2026-08-04", quantity: "10", price: "130", fees: "5", taxes: "2" },
    EQ
  );
  assert.equal(n(r.grossAmount), 1300);
  assert.equal(n(r.netAmount), 1293);
});

test("SELL in cui i costi superano il ricavo: warning, non un silenzio", () => {
  const r = computeAmounts(
    { type: "SELL", tradeDate: "2026-08-04", quantity: "1", price: "1", fees: "10", taxes: "0" },
    EQ
  );
  assert.ok(r.warnings.some((w) => w.code === "net_negative"));
});

test("BUY obbligazionario per NOMINALE: quantità derivata, rateo automatico", () => {
  // Il form accetta il nominale (quello che mostra il broker) e deriva la quantità.
  const r = computeAmounts(
    { type: "BUY", tradeDate: "2026-04-02", nominal: "10000", price: "98.5", fees: "8" },
    BOND
  );
  assert.equal(n(r.quantity), 10, "10.000 nominali / 1.000 di facciale = 10 titoli");
  assert.equal(n(r.nominal), 10000);
  assert.equal(n(r.grossAmount), 9850, "nominale × prezzo/100");
  assert.equal(r.autoAccrued, true);
  // Rateo: periodo 2026-01-01 → 2026-07-01 (181 giorni), 91 maturati.
  // 1,725 × 91/181 per 100 di nominale, su 10.000 → ~86,73.
  assert.ok(Math.abs(n(r.accruedInterest) - 86.726519) < 0.001);
  // Il netto INCLUDE il rateo pagato: è cassa che esce davvero.
  assert.equal(n(r.netAmount), -(9850 + 8 + n(r.accruedInterest)));
});

test("BUY obbligazionario per QUANTITÀ: il nominale è derivato all'inverso", () => {
  const r = computeAmounts(
    { type: "BUY", tradeDate: "2026-04-02", quantity: "10", price: "98.5", fees: "8" },
    BOND
  );
  assert.equal(n(r.quantity), 10);
  assert.equal(n(r.nominal), 10000);
  assert.equal(n(r.grossAmount), 9850);
});

test("il rateo indicato a mano VINCE su quello calcolato", () => {
  // Lo scadenzario è una proiezione, l'estratto conto è la verità.
  const r = computeAmounts(
    {
      type: "BUY",
      tradeDate: "2026-04-02",
      nominal: "10000",
      price: "98.5",
      accruedInterest: "90",
    },
    BOND
  );
  assert.equal(n(r.accruedInterest), 90);
  assert.equal(r.autoAccrued, false);
  assert.equal(n(r.netAmount), -9940);
});

test("SELL obbligazionario: il rateo si INCASSA, quindi aumenta il netto", () => {
  const r = computeAmounts(
    { type: "SELL", tradeDate: "2026-04-02", nominal: "10000", price: "99", fees: "8" },
    BOND
  );
  assert.equal(n(r.grossAmount), 9900);
  assert.ok(n(r.accruedInterest) > 0);
  assert.equal(n(r.netAmount), 9900 - 8 + n(r.accruedInterest));
});

test("uno strumento senza faceValue non viene trattato come % del nominale", () => {
  // Nessuna moltiplicazione fantasma per 1000 quando i metadati mancano.
  const r = computeAmounts(
    { type: "BUY", tradeDate: "2026-08-04", quantity: "10", price: "98.5" },
    null
  );
  assert.equal(n(r.grossAmount), 985);
  assert.equal(r.nominal, null);
});

test("DIVIDEND: lordo dall'utente, netto = lordo - ritenuta", () => {
  const r = computeAmounts(
    { type: "DIVIDEND", tradeDate: "2026-09-01", grossAmount: "80", taxes: "20.80" },
    EQ
  );
  assert.equal(n(r.grossAmount), 80);
  assert.equal(n(r.netAmount), 59.2);
  assert.equal(n(r.accruedInterest), 0);
});

test("COUPON: ritenuta 12,5% su titoli di Stato", () => {
  const r = computeAmounts(
    { type: "COUPON", tradeDate: "2026-07-01", grossAmount: "172.50", taxes: "21.5625" },
    BOND
  );
  assert.equal(n(r.grossAmount), 172.5);
  assert.equal(n(r.netAmount), 150.9375);
});

test("un reddito con ritenuta superiore al lordo produce un warning", () => {
  const r = computeAmounts(
    { type: "DIVIDEND", tradeDate: "2026-09-01", grossAmount: "10", taxes: "15" },
    EQ
  );
  assert.ok(r.warnings.some((w) => w.code === "net_negative"));
});

test("FEE e TAX sono sempre uscite, anche se l'importo arriva positivo", () => {
  for (const type of ["FEE", "TAX"]) {
    const r = computeAmounts({ type, tradeDate: "2026-08-04", grossAmount: "15" }, EQ);
    assert.equal(n(r.netAmount), -15, `${type} deve essere negativo`);
    assert.equal(n(r.grossAmount), 15);
  }
  // E anche se arriva già negativo: il segno lo decide il TIPO, non l'input.
  const r = computeAmounts({ type: "FEE", tradeDate: "2026-08-04", grossAmount: "-15" }, EQ);
  assert.equal(n(r.netAmount), -15);
});

test("DEPOSIT è entrata, WITHDRAWAL è uscita", () => {
  const dep = computeAmounts({ type: "DEPOSIT", tradeDate: "2026-08-04", grossAmount: "5000" }, null);
  assert.equal(n(dep.netAmount), 5000);
  const wit = computeAmounts({ type: "WITHDRAWAL", tradeDate: "2026-08-04", grossAmount: "2000" }, null);
  assert.equal(n(wit.netAmount), -2000);
  // Anche con segno "sbagliato" in input.
  const wit2 = computeAmounts({ type: "WITHDRAWAL", tradeDate: "2026-08-04", grossAmount: "-2000" }, null);
  assert.equal(n(wit2.netAmount), -2000);
});

test("RETURN_OF_CAPITAL è un'entrata", () => {
  const r = computeAmounts(
    { type: "RETURN_OF_CAPITAL", tradeDate: "2026-08-04", grossAmount: "300" },
    EQ
  );
  assert.equal(n(r.netAmount), 300);
});

test("SPLIT non muove cassa: netto ESATTAMENTE 0 (lo esige il CHECK del database)", () => {
  const r = computeAmounts({ type: "SPLIT", tradeDate: "2026-08-04", splitRatio: "4" }, EQ);
  assert.equal(r.netAmount, "0");
  assert.equal(r.grossAmount, null);
  assert.equal(n(r.accruedInterest), 0);
});

test("un tipo non gestito produce un warning invece di un netto inventato", () => {
  const r = computeAmounts({ type: "PIPPO", tradeDate: "2026-08-04" }, EQ);
  assert.ok(r.warnings.some((w) => w.code === "unknown_type"));
  assert.equal(r.netAmount, "0");
});

test("tutti i valori restituiti sono STRINGHE, mai number", () => {
  const r = computeAmounts(
    { type: "BUY", tradeDate: "2026-04-02", nominal: "10000", price: "98.5", fees: "8" },
    BOND
  );
  for (const k of ["grossAmount", "netAmount", "accruedInterest", "quantity", "nominal"]) {
    assert.equal(typeof r[k], "string", `${k} deve essere una stringa`);
  }
});

test("nessuna deriva float: 0,07 × 3 quote resta esatto", () => {
  const r = computeAmounts(
    { type: "BUY", tradeDate: "2026-08-04", quantity: "3", price: "0.07", fees: "0" },
    EQ
  );
  // 3 × 0,07 = 0,21 ESATTO. In float sarebbe 0.21000000000000002, e la stringa
  // porterebbe la coda. Gli zeri finali non contano: conta che non ci sia rumore.
  assert.equal(r.grossAmount, "0.21");
  assert.equal(r.netAmount, "-0.21");
  assert.notEqual(r.grossAmount, String(3 * 0.07), "controllo: il float sbaglia davvero");
});

test("un rateo su un bond senza scadenzario non fa esplodere il calcolo", () => {
  const senzaCedole = { ...BOND, couponFrequency: 0, couponRate: "0", firstCouponDate: null };
  const r = computeAmounts(
    { type: "BUY", tradeDate: "2026-04-02", nominal: "10000", price: "98.5" },
    senzaCedole
  );
  assert.equal(n(r.accruedInterest), 0, "uno zero coupon non ha rateo");
  assert.equal(n(r.netAmount), -9850);
});
