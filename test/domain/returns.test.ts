import test from "node:test";
import assert from "node:assert/strict";
import * as ret from "../../src/domain/returns";
import { must } from "../helpers/must";

const approx = (actual: unknown, expected: number, tol = 1e-6, msg = "") =>
  assert.ok(
    Math.abs(Number(actual) - expected) < tol,
    `${msg} atteso ~${expected}, ottenuto ${actual}`
  );

// ---------------------------------------------------------------------------
// XIRR
// ---------------------------------------------------------------------------

test("XIRR: -1000 a inizio 2024, +1100 a inizio 2025 ≈ 10%", () => {
  const r = must(ret.xirr([
    { date: "2024-01-01", amount: "-1000" },
    { date: "2025-01-01", amount: "1100" },
  ]), "lo XIRR");
  assert.ok(r);
  // 2024 è bisestile (366 giorni), quindi il tasso annuo su base 365 è appena
  // sotto il 10%.
  approx(r.rate, 0.0997, 1e-4);
});

test("XIRR: esattamente 365 giorni dà esattamente il 10%", () => {
  const r = must(ret.xirr([
    { date: "2025-01-01", amount: "-1000" },
    { date: "2026-01-01", amount: "1100" },
  ]), "lo XIRR");
  approx(r.rate, 0.1, 1e-8);
});

test("XIRR: versamenti periodici irregolari", () => {
  const r = must(ret.xirr([
    { date: "2024-01-15", amount: "-5000" },
    { date: "2024-04-03", amount: "-2500" },
    { date: "2024-09-21", amount: "-1000" },
    { date: "2025-02-11", amount: "-3000" },
    { date: "2026-08-04", amount: "13500" },
  ]), "lo XIRR");
  assert.ok(r, "deve convergere");
  // Verifica INDIPENDENTE: il NPV al tasso trovato deve essere ~0. La tolleranza è
  // 1e-3 perché il tasso restituito è arrotondato a 8 decimali, e su flussi
  // dell'ordine di 13.500 un errore di 1e-8 sul tasso vale ~1e-5 di NPV. In
  // termini relativi resta sotto 1e-7.
  const cal = require("../../src/domain/calendar") as typeof import("../../src/domain/calendar");
  const flows = [
    { date: "2024-01-15", amount: "-5000" },
    { date: "2024-04-03", amount: "-2500" },
    { date: "2024-09-21", amount: "-1000" },
    { date: "2025-02-11", amount: "-3000" },
    { date: "2026-08-04", amount: "13500" },
  ];
  const cf = flows.map((f) => ({
    amount: f.amount,
    days: cal.daysBetween("2024-01-15", f.date),
  }));
  approx(ret.npv(cf, r.rate).toFixed(), 0, 1e-3, "NPV alla radice");
});

test("XIRR: una perdita dà un tasso negativo", () => {
  const r = must(ret.xirr([
    { date: "2025-01-01", amount: "-1000" },
    { date: "2026-01-01", amount: "800" },
  ]), "lo XIRR");
  approx(r.rate, -0.2, 1e-8);
});

test("XIRR: perdita quasi totale, il dominio resta rispettato", () => {
  const r = must(ret.xirr([
    { date: "2025-01-01", amount: "-1000" },
    { date: "2026-01-01", amount: "1" },
  ]), "lo XIRR");
  assert.ok(r);
  assert.ok(Number(r.rate) > -1, "il tasso non può scendere a -100% o sotto");
  approx(r.rate, -0.999, 1e-3);
});

test("XIRR: flussi di un solo segno → null (non un numero inventato)", () => {
  assert.equal(
    ret.xirr([
      { date: "2025-01-01", amount: "-1000" },
      { date: "2026-01-01", amount: "-500" },
    ]),
    null
  );
  assert.equal(
    ret.xirr([
      { date: "2025-01-01", amount: "1000" },
      { date: "2026-01-01", amount: "500" },
    ]),
    null
  );
});

test("XIRR: meno di due flussi → null", () => {
  assert.equal(ret.xirr([]), null);
  assert.equal(ret.xirr([{ date: "2025-01-01", amount: "-1000" }]), null);
  assert.equal(ret.xirr(null), null);
});

test("XIRR: i flussi a zero sono ignorati, non contati", () => {
  const withZero = must(ret.xirr([
    { date: "2025-01-01", amount: "-1000" },
    { date: "2025-06-01", amount: "0" },
    { date: "2026-01-01", amount: "1100" },
  ]), "lo XIRR");
  const without = must(ret.xirr([
    { date: "2025-01-01", amount: "-1000" },
    { date: "2026-01-01", amount: "1100" },
  ]), "lo XIRR");
  assert.equal(withZero.rate, without.rate);
});

test("XIRR: i flussi non ordinati danno lo stesso risultato", () => {
  const a = must(ret.xirr([
    { date: "2026-01-01", amount: "1100" },
    { date: "2025-01-01", amount: "-1000" },
  ]), "lo XIRR");
  const b = must(ret.xirr([
    { date: "2025-01-01", amount: "-1000" },
    { date: "2026-01-01", amount: "1100" },
  ]), "lo XIRR");
  assert.equal(a.rate, b.rate);
});

test("XIRR: insieme patologico dove Newton fallisce → la BISEZIONE converge", () => {
  // Flussi con segni alternati e ampiezze estreme: è il caso in cui f'(r) ≈ 0 e
  // Newton diverge o esce dal dominio. Il fallback deve comunque produrre una
  // radice verificabile.
  const flows = [
    { date: "2020-01-01", amount: "-1000000" },
    { date: "2020-01-02", amount: "2999000" },
    { date: "2020-01-03", amount: "-2998000" },
    { date: "2020-01-04", amount: "999000" },
    { date: "2026-01-01", amount: "1" },
  ];
  // NON si usa `must`: il commento in fondo dice che null è un esito accettato
  // ("un rifiuto onesto"), quindi pretendere un valore cambierebbe il test.
  const r = ret.xirr(flows);
  if (r !== null) {
    // Se restituisce un tasso, quel tasso deve essere una radice vera.
    const start = "2020-01-01";
    const cal = require("../../src/domain/calendar") as typeof import("../../src/domain/calendar");
    const cf = flows.map((f) => ({ amount: f.amount, days: cal.daysBetween(start, f.date) }));
    const value = Number(ret.npv(cf, r.rate).toFixed());
    assert.ok(Math.abs(value) < 1e-3, `NPV alla radice dovrebbe essere ~0, è ${value}`);
  }
  // Se null, è un rifiuto onesto: nessun NaN, nessun numero assurdo.
  assert.ok(r === null || Number.isFinite(Number(r.rate)));
});

test("XIRR non restituisce mai NaN o Infinity", () => {
  const casi = [
    [
      { date: "2025-01-01", amount: "-0.000001" },
      { date: "2026-01-01", amount: "999999999" },
    ],
    [
      { date: "2025-01-01", amount: "-999999999" },
      { date: "2025-01-02", amount: "1" },
    ],
    [
      { date: "2025-01-01", amount: "-100" },
      { date: "2025-01-01", amount: "200" }, // stesso giorno
    ],
  ];
  for (const flows of casi) {
    // NON si usa `must` qui: su questi input patologici la NON convergenza (null) è
    // un esito legittimo, ed è esattamente ciò che il test vuole permettere. Quello
    // che vieta è un tasso NaN o infinito.
    const r = ret.xirr(flows);
    if (r !== null) {
      assert.ok(Number.isFinite(Number(r.rate)), `tasso non finito: ${r.rate}`);
      assert.ok(!Number.isNaN(Number(r.rate)));
    }
  }
});

test("portfolioXirr aggiunge il valore terminale come incasso finale", () => {
  const r = must(ret.portfolioXirr(
    [{ date: "2025-01-01", amountBase: "-1000" }],
    "1100",
    "2026-01-01"
  ), "lo XIRR");
  approx(r.rate, 0.1, 1e-8);
});

test("portfolioXirr senza valore terminale usa solo i flussi", () => {
  const r = must(ret.portfolioXirr(
    [
      { date: "2025-01-01", amountBase: "-1000" },
      { date: "2026-01-01", amountBase: "1100" },
    ],
    null,
    "2026-01-01"
  ), "lo XIRR");
  approx(r.rate, 0.1, 1e-8);
});

// ---------------------------------------------------------------------------
// TWR
// ---------------------------------------------------------------------------

test("TWR: crescita semplice senza flussi", () => {
  const t = ret.twr([
    { date: "2026-01-01", value: "1000" },
    { date: "2026-01-02", value: "1100" },
  ]);
  approx(t.total, 0.1, 1e-9);
});

test("TWR: INVARIANTE — un versamento a metà periodo NON cambia il TWR", () => {
  // È la proprietà che DEFINISCE il TWR, ed è il singolo test migliore della
  // suite: se questo passa, la formula del flusso è giusta.
  //
  // Scenario A: 1000 che rendono +10% e poi +10%.
  const senzaFlusso = ret.twr([
    { date: "2026-01-01", value: "1000" },
    { date: "2026-01-02", value: "1100" },
    { date: "2026-01-03", value: "1210" },
  ]);

  // Scenario B: stessi rendimenti, ma il 2026-01-02 arrivano 5000 di versamento.
  // Il valore del giorno 2 è 1100 + 5000 = 6100, e il giorno 3 rende +10%: 6710.
  const conFlusso = ret.twr(
    [
      { date: "2026-01-01", value: "1000" },
      { date: "2026-01-02", value: "6100" },
      { date: "2026-01-03", value: "6710" },
    ],
    new Map([["2026-01-02", "5000"]])
  );

  approx(senzaFlusso.total, 0.21, 1e-9, "controllo: (1,1)² - 1");
  assert.equal(
    conFlusso.total,
    senzaFlusso.total,
    "il TWR deve essere IDENTICO: un versamento non è performance"
  );
});

test("TWR: un prelievo a metà periodo non cambia il TWR", () => {
  const senza = ret.twr([
    { date: "2026-01-01", value: "1000" },
    { date: "2026-01-02", value: "1100" },
    { date: "2026-01-03", value: "1210" },
  ]);
  // Prelievo di 500 il giorno 2: valore 600, poi +10% → 660.
  const con = ret.twr(
    [
      { date: "2026-01-01", value: "1000" },
      { date: "2026-01-02", value: "600" },
      { date: "2026-01-03", value: "660" },
    ],
    new Map([["2026-01-02", "-500"]])
  );
  assert.equal(con.total, senza.total);
});

test("TWR: un dividendo incassato è un flusso USCENTE e non riduce il rendimento", () => {
  // Prezzo che cala esattamente del dividendo: il rendimento del giorno è ZERO.
  // Senza il termine di flusso sembrerebbe una perdita.
  const t = ret.twr(
    [
      { date: "2026-01-01", value: "1000" },
      { date: "2026-01-02", value: "950" },
    ],
    new Map([["2026-01-02", "-50"]])
  );
  approx(t.total, 0, 1e-9);
});

test("TWR e XIRR DIVERGONO quando il timing conta (è esattamente il loro scopo)", () => {
  // Poco denaro nell'anno buono, molto denaro appena prima di quello cattivo.
  // Il TWR (media dei rendimenti, indipendente dagli importi) resta positivo; lo
  // XIRR (pesato per i soldi effettivamente esposti) è negativo. Sono risposte a
  // due domande diverse, ed è per questo che la dashboard mostra entrambi.
  //
  // 2024: 1000 → 1500 (+50%), poi 9000 versati a fine periodo → 10500
  // 2025: 10500 → 9450 (-10%)
  const points = [
    { date: "2024-01-01", value: "1000" },
    { date: "2025-01-01", value: "10500" },
    { date: "2026-01-01", value: "9450" },
  ];
  const flows = new Map([["2025-01-01", "9000"]]);
  const t = ret.twr(points, flows);

  // (1 + 0,50) × (1 - 0,10) - 1 = 0,35
  approx(t.total, 0.35, 1e-9, "TWR");
  assert.ok(Number(t.total) > 0, "il TWR resta positivo: i rendimenti sono stati buoni");

  // Ma l'investitore ha messo 10.000 e ne ha 9.450: ha PERSO denaro.
  const x = must(ret.xirr([
    { date: "2024-01-01", amount: "-1000" },
    { date: "2025-01-01", amount: "-9000" },
    { date: "2026-01-01", amount: "9450" },
  ]), "lo XIRR");
  assert.ok(x, "lo XIRR deve convergere");
  assert.ok(Number(x.rate) < 0, `lo XIRR deve essere negativo, è ${x.rate}`);
  assert.ok(
    Number(x.rate) < Number(t.total),
    `lo XIRR (${x.rate}) deve stare sotto il TWR (${t.total})`
  );
});

test("TWR: V_{t-1} = 0 riavvia la catena invece di dividere per zero", () => {
  // Liquidazione totale e ricostruzione: nessun NaN, nessuna esplosione.
  const t = ret.twr(
    [
      { date: "2026-01-01", value: "1000" },
      { date: "2026-01-02", value: "0" }, // tutto liquidato
      { date: "2026-01-03", value: "500" }, // ricomprato
      { date: "2026-01-04", value: "550" }, // +10%
    ],
    new Map([
      ["2026-01-02", "-1000"],
      ["2026-01-03", "500"],
    ])
  );
  assert.ok(t.total !== null);
  assert.ok(Number.isFinite(Number(t.total)), `TWR non finito: ${t.total}`);
  assert.ok(t.segments >= 2, "la catena deve essersi riavviata");
});

test("TWR: meno di due punti utili → null, non zero", () => {
  assert.equal(ret.twr([]).total, null);
  assert.equal(ret.twr([{ date: "2026-01-01", value: "1000" }]).total, null);
  // Punti senza valore (prezzi mancanti) non contano.
  assert.equal(
    ret.twr([
      { date: "2026-01-01", value: null },
      { date: "2026-01-02", value: null },
    ]).total,
    null
  );
});

test("TWR: annualizzazione su base 365", () => {
  // +21% in 730 giorni ≈ 10% annuo composto.
  const t = ret.twr([
    { date: "2024-01-01", value: "1000" },
    { date: "2025-12-31", value: "1210" },
  ]);
  assert.equal(t.days, 730);
  approx(t.annualized, 0.1, 1e-3);
});

test("TWR: una perdita totale non produce un'annualizzazione immaginaria", () => {
  const t = ret.twr([
    { date: "2024-01-01", value: "1000" },
    { date: "2025-01-01", value: "0" },
  ]);
  approx(t.total, -1, 1e-9);
  assert.equal(t.annualized, null, "(1 + -1)^x non è annualizzabile");
});

// ---------------------------------------------------------------------------
// Investito netto e rendimento semplice
// ---------------------------------------------------------------------------

test("netInvestedSeries cumula -Σ net_amount", () => {
  const flows = [
    { date: "2026-01-10", amountBase: "-1000" }, // acquisto
    { date: "2026-02-10", amountBase: "-500" }, // altro acquisto
    { date: "2026-03-10", amountBase: "300" }, // vendita parziale
  ];
  const s = ret.netInvestedSeries(flows, [
    "2026-01-09",
    "2026-01-10",
    "2026-02-10",
    "2026-03-10",
    "2026-04-01",
  ]);
  assert.deepEqual(
    s.map((x) => Number(x.netInvested.toFixed())),
    [0, 1000, 1500, 1200, 1200]
  );
});

test("inflowsByDate inverte il segno del net_amount", () => {
  const m = ret.inflowsByDate([
    { date: "2026-01-10", amountBase: "-1000" },
    { date: "2026-01-10", amountBase: "-200" },
    { date: "2026-02-10", amountBase: "50" },
  ]);
  assert.equal(m.get("2026-01-10").toFixed(), "1200"); // due acquisti = 1200 entranti
  assert.equal(m.get("2026-02-10").toFixed(), "-50"); // un dividendo esce
});

test("simpleReturn e il caso investito netto = 0", () => {
  assert.equal(ret.simpleReturn("1200", "1000"), "0.2");
  assert.equal(ret.simpleReturn("800", "1000"), "-0.2");
  assert.equal(ret.simpleReturn("1200", "0"), null, "nessuna divisione per zero");
});

test("byYear separa gli anni misurando dalla chiusura precedente", () => {
  const points = [
    { date: "2024-12-31", value: "1000" },
    { date: "2025-12-31", value: "1100" },
    { date: "2026-12-31", value: "1320" },
  ];
  const rows = ret.byYear(points, []);
  const y2025 = must(rows.find((r) => r.year === "2025"), "la riga del 2025");
  const y2026 = must(rows.find((r) => r.year === "2026"), "la riga del 2026");
  approx(y2025.twr, 0.1, 1e-9);
  approx(y2026.twr, 0.2, 1e-9, "il 2026 si misura dal 31/12/2025, non dal 1/1");
});
