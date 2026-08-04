const test = require("node:test");
const assert = require("node:assert/strict");
const m = require("../../src/domain/money");

test("0,1 + 0,2 fa ESATTAMENTE 0,3 (il motivo per cui esiste questo modulo)", () => {
  // In float 0.1 + 0.2 === 0.30000000000000004.
  assert.equal(m.d("0.1").plus("0.2").eq("0.3"), true);
  assert.equal(m.d("0.1").plus("0.2").toFixed(), "0.3");
  assert.notEqual(0.1 + 0.2, 0.3, "controllo: i float sbagliano davvero");
});

test("la somma di 0,1 diecimila volte non deriva", () => {
  let acc = m.ZERO;
  for (let i = 0; i < 10000; i++) acc = acc.plus("0.1");
  assert.equal(acc.toFixed(), "1000");

  let f = 0;
  for (let i = 0; i < 10000; i++) f += 0.1;
  assert.notEqual(f, 1000, "controllo: la somma float deriva");
});

test("d() è tollerante su null/undefined/vuoto/spazzatura", () => {
  assert.equal(m.d(null).toFixed(), "0");
  assert.equal(m.d(undefined).toFixed(), "0");
  assert.equal(m.d("").toFixed(), "0");
  assert.equal(m.d("  42.5  ").toFixed(), "42.5");
  assert.equal(m.d("non-un-numero").toFixed(), "0");
  assert.equal(m.d(NaN).toFixed(), "0");
  assert.equal(m.d(Infinity).toFixed(), "0");
  assert.equal(m.d(null, 7).toFixed(), "7", "il default è configurabile");
  // Un Decimal passa attraverso senza copia.
  const x = m.d("1.5");
  assert.equal(m.d(x), x);
});

test("isBlank distingue 'assente' da 'zero'", () => {
  assert.equal(m.isBlank(null), true);
  assert.equal(m.isBlank(undefined), true);
  assert.equal(m.isBlank(""), true);
  assert.equal(m.isBlank("pippo"), true);
  assert.equal(m.isBlank("0"), false, "zero è un valore, non un'assenza");
  assert.equal(m.isBlank(0), false);
  assert.equal(m.isBlank("0.00"), false);
});

test("ROUND_HALF_EVEN: arrotondamento del banchiere, non HALF_UP", () => {
  // 0,5 va al pari più vicino: 2,5 → 2 e 3,5 → 4. È questo che evita il bias
  // verso l'alto su migliaia di arrotondamenti.
  assert.equal(m.fixed("2.5", 0), "2");
  assert.equal(m.fixed("3.5", 0), "4");
  assert.equal(m.fixed("0.125", 2), "0.12");
  assert.equal(m.fixed("0.135", 2), "0.14");
  // HALF_UP darebbe 3 e 4: la differenza è il bias.
  assert.notEqual(m.fixed("2.5", 0), "3");
});

test("l'arrotondamento del banchiere non introduce bias su molti valori", () => {
  // Somma di 1000 valori che finiscono in ,5: con HALF_UP l'errore accumulato
  // sarebbe sistematicamente positivo.
  let rounded = m.ZERO;
  let exact = m.ZERO;
  for (let i = 0; i < 1000; i++) {
    const v = m.d(`${i}.5`);
    exact = exact.plus(v);
    rounded = rounded.plus(m.fixed(v, 0));
  }
  const bias = rounded.minus(exact).abs();
  assert.ok(bias.lte(500), `bias troppo alto: ${bias.toFixed()}`);
});

test("i formattatori restituiscono STRINGHE con la scale della colonna", () => {
  assert.equal(m.money("1234.5"), "1234.500000"); // NUMERIC(20,6)
  assert.equal(m.qty("10"), "10.00000000"); // NUMERIC(28,8)
  assert.equal(m.price("98.5"), "98.50000000");
  assert.equal(m.fx("1.1523"), "1.1523000000"); // NUMERIC(20,10)
  for (const v of [m.money("1"), m.qty("1"), m.fx("1")]) assert.equal(typeof v, "string");
});

test("nessuna notazione esponenziale nell'output (finirebbe nel JSON)", () => {
  assert.equal(m.d("0.00000001").toFixed(), "0.00000001");
  assert.ok(!m.d("0.0000000001").toFixed().includes("e"));
  assert.ok(!m.d("100000000000000000000").toFixed().includes("e"));
  assert.equal(m.money("0.0000005"), "0.000000", "sotto la scale si arrotonda, non si esplode");
});

test("toBase converte DIVIDENDO (la direzione FX è EUR→X)", () => {
  // 1000 USD con EURUSD 1,25 → 800 EUR. Moltiplicare darebbe 1250: è il bug FX
  // classico, ed è per questo che la direzione è dichiarata una volta sola.
  assert.equal(m.toBase("1000", "1.25").toFixed(), "800");
  assert.equal(m.toBase("1000", "1").toFixed(), "1000");
  assert.equal(m.fromBase("800", "1.25").toFixed(), "1000");
  // Round-trip.
  assert.equal(m.toBase(m.fromBase("123.45", "1.1523"), "1.1523").toFixed(), "123.45");
});

test("toBase con tasso zero restituisce 0 invece di Infinity", () => {
  assert.equal(m.toBase("1000", "0").toFixed(), "0");
  assert.equal(m.toBase("1000", null).toFixed(), "1000", "tasso assente → 1");
});

test("share e safeDiv non producono NaN né Infinity", () => {
  assert.equal(m.share("25", "100").toFixed(), "0.25");
  assert.equal(m.share("25", "0").toFixed(), "0", "totale zero → peso zero, non NaN");
  assert.equal(m.safeDiv("10", "0"), null);
  assert.equal(m.safeDiv("10", "4").toFixed(), "2.5");
});

test("sum somma una lista mista", () => {
  assert.equal(m.sum(["1.1", "2.2", "3.3"]).toFixed(), "6.6");
  assert.equal(m.sum([]).toFixed(), "0");
  assert.equal(m.sum([null, "5", undefined, ""]).toFixed(), "5");
});

test("la precisione regge una catena qty × prezzo × fx", () => {
  // 3 quote frazionarie a 8 decimali, prezzo a 8, cambio a 10.
  const qty = m.d("0.33333333");
  const price = m.d("1234.56789012");
  const fx = m.d("1.1234567891");
  const eur = m.toBase(qty.times(price), fx);
  // Verifica indipendente con precisione arbitraria: il risultato deve avere
  // almeno 20 cifre significative corrette.
  const expected = m.d("0.33333333").times("1234.56789012").div("1.1234567891");
  assert.equal(eur.minus(expected).abs().lt("1e-25"), true);
  assert.equal(m.money(eur), "366.300360");
  // Controllo grossolano indipendente: ~411,52 USD a ~1,1235 fa ~366,3 EUR.
  assert.ok(Math.abs(Number(m.money(eur)) - (0.33333333 * 1234.56789012) / 1.1234567891) < 1e-4);
});

test("DP dichiara le scale usate dallo schema", () => {
  assert.deepEqual(m.DP, { QTY: 8, PRICE: 8, MONEY: 6, FX: 10, RATE: 8, DISPLAY: 2 });
});

test("domain/ importa SOLO decimal.js (confine architetturale)", () => {
  // Il confine che rende testabile la matematica senza database: se qualcuno
  // aggiunge un require di pg o del logger dentro domain/, questo test lo blocca.
  const fs = require("node:fs");
  const path = require("node:path");
  const dir = path.join(__dirname, "..", "..", "src", "domain");
  const vietati = ["pg", "../logger", "../db/", "../market/", "../http/", "express", "node-cron"];

  // I commenti vanno rimossi prima di analizzare: questi file PARLANO delle regole
  // che rispettano ("il dominio non chiama mai Date.now()"), e cercare nel testo
  // grezzo darebbe un falso positivo su ogni commento ben scritto.
  const stripComments = (s) =>
    s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");

  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".js"))) {
    const src = stripComments(fs.readFileSync(path.join(dir, file), "utf8"));
    const requires = [...src.matchAll(/require\(["']([^"']+)["']\)/g)].map((x) => x[1]);
    for (const r of requires) {
      assert.ok(
        r === "decimal.js" || r.startsWith("./"),
        `${file} importa ${r}: domain/ può importare solo decimal.js e moduli locali`
      );
      for (const v of vietati) {
        assert.ok(!r.includes(v), `${file} importa ${r}, vietato in domain/`);
      }
    }
    // Il tempo è un PARAMETRO in domain/, non una lettura dell'orologio.
    assert.ok(!/Date\.now\(\)/.test(src), `${file} chiama Date.now(): il tempo deve essere un parametro`);
    assert.ok(!/new Date\(\)/.test(src), `${file} chiama new Date(): il tempo deve essere un parametro`);
  }
});
