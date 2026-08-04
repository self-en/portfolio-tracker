const test = require("node:test");
const assert = require("node:assert/strict");
const bonds = require("../../src/domain/bonds");

// BTP 3,45% con scadenza 01/07/2030, cedola semestrale. coupon_rate è una
// FRAZIONE annua (docs/decisions.md §9), quindi ogni cedola è 3,45/2 = 1,725
// per 100 di nominale.
const BTP = {
  couponRate: "0.0345",
  couponFrequency: 2,
  firstCouponDate: "2025-01-01",
  maturityDate: "2030-07-01",
  dayCount: "ACT/ACT-ICMA",
  faceValue: "1000",
};

test("BTP semestrale: scadenzario generato all'indietro dalla scadenza", () => {
  const s = bonds.couponSchedule(BTP);
  const dates = s.map((p) => p.payDate);

  // 12 cedole da gen 2025 a lug 2030, tutte al 1° gennaio e 1° luglio: è la
  // catena a passi di 6 mesi ANCORATA ALLA SCADENZA.
  assert.deepEqual(dates, [
    "2025-01-01",
    "2025-07-01",
    "2026-01-01",
    "2026-07-01",
    "2027-01-01",
    "2027-07-01",
    "2028-01-01",
    "2028-07-01",
    "2029-01-01",
    "2029-07-01",
    "2030-01-01",
    "2030-07-01",
  ]);

  assert.equal(dates[dates.length - 1], "2030-07-01", "l'ultima cedola è alla scadenza");
  for (const p of s) {
    assert.equal(p.irregular, false, `${p.payDate} non dovrebbe essere irregolare`);
    assert.equal(p.amountPer100, "1.725", `cedola sbagliata su ${p.payDate}`);
  }
});

test("i periodi sono contigui: periodEnd di uno è periodStart del successivo", () => {
  const s = bonds.couponSchedule(BTP);
  for (let i = 1; i < s.length; i++) {
    assert.equal(s[i].periodStart, s[i - 1].periodEnd, `discontinuità all'indice ${i}`);
  }
  // Il primo periodo parte 6 mesi prima della prima cedola.
  assert.equal(s[0].periodStart, "2024-07-01");
});

test("scadenza a fine mese: TUTTE le cedole restano a fine mese", () => {
  // Il caso che rompe sempre il codice degli scadenzari: 30 novembre + 6 mesi
  // deve dare 31 maggio, non 30 maggio.
  const s = bonds.couponSchedule({
    couponRate: "0.04",
    couponFrequency: 2,
    firstCouponDate: "2025-05-31",
    maturityDate: "2027-11-30",
  });
  assert.deepEqual(
    s.map((p) => p.payDate),
    ["2025-05-31", "2025-11-30", "2026-05-31", "2026-11-30", "2027-05-31", "2027-11-30"]
  );
  for (const p of s) assert.equal(p.irregular, false);
});

test("scadenza il 29 febbraio di un bisestile", () => {
  const s = bonds.couponSchedule({
    couponRate: "0.03",
    couponFrequency: 1,
    firstCouponDate: "2025-02-28",
    maturityDate: "2028-02-29",
  });
  // Ancorata al 29/02/2028: risalendo di 12 mesi si ottiene il 28 febbraio negli
  // anni non bisestili, e il 29 quando l'anno lo consente.
  assert.deepEqual(s.map((p) => p.payDate), [
    "2025-02-28",
    "2026-02-28",
    "2027-02-28",
    "2028-02-29",
  ]);
  assert.equal(s[s.length - 1].payDate, "2028-02-29");
  assert.equal(s[0].periodStart, "2024-02-29", "il periodo precedente cade in un bisestile");
});

test("prima cedola CORTA: prorata, non una cedola piena", () => {
  // Emissione a ottobre, prima cedola a gennaio su un semestrale ancorato a
  // gennaio/luglio: il primo periodo è di 3 mesi, non 6.
  const s = bonds.couponSchedule({
    couponRate: "0.04", // 2,00 per semestre
    couponFrequency: 2,
    firstCouponDate: "2025-01-01",
    maturityDate: "2028-07-01",
  });
  // Il primo periodo quasi-cedolare va da 2024-07-01 a 2025-01-01, quindi in
  // questo caso è regolare: la prima cedola è piena.
  assert.equal(s[0].payDate, "2025-01-01");
  assert.equal(s[0].irregular, false);
  assert.equal(s[0].amountPer100, "2");

  // Ora uno STUB reale: data di godimento 2024-10-01, fuori dalla griglia
  // gennaio/luglio. La prima cedola resta sulla griglia (2025-01-01) ma matura
  // solo per 3 mesi.
  const short = bonds.couponSchedule({
    couponRate: "0.04",
    couponFrequency: 2,
    firstCouponDate: "2024-10-01",
    maturityDate: "2028-07-01",
  });
  assert.equal(short[0].payDate, "2025-01-01", "le DATE cedola restano sulla griglia");
  assert.equal(short[0].periodStart, "2024-10-01", "ma la maturazione parte dal godimento");
  assert.equal(short[0].irregular, true, "il primo periodo è uno stub");
  // 2024-10-01 → 2025-01-01 = 92 giorni sul quasi-periodo 2024-07-01 → 2025-01-01
  // di 184 giorni → 2,00 × 92/184 = 1,00: esattamente metà cedola.
  assert.equal(Number(short[0].amountPer100).toFixed(6), "1.000000");

  // Le successive tornano regolari, piene e ALLINEATE ALLA GRIGLIA: è questo che
  // distingue uno stub corretto da un errore che si propaga per tutta la vita del
  // titolo.
  assert.equal(short[1].payDate, "2025-07-01");
  assert.equal(short[1].periodStart, "2025-01-01");
  assert.equal(short[1].irregular, false);
  assert.equal(short[1].amountPer100, "2");
  for (const p of short.slice(1)) {
    assert.equal(p.irregular, false, `${p.payDate} dovrebbe essere regolare`);
    assert.equal(p.amountPer100, "2");
  }
  assert.equal(short[short.length - 1].payDate, "2028-07-01");
});

test("stub: il rateo durante il primo periodo parte dal godimento, non dalla griglia", () => {
  const stub = {
    couponRate: "0.04",
    couponFrequency: 2,
    firstCouponDate: "2024-10-01",
    maturityDate: "2028-07-01",
    dayCount: "ACT/ACT-ICMA",
  };
  // Il giorno del godimento: rateo zero.
  assert.equal(bonds.accruedInterest(stub, "2024-10-01").accruedPer100, "0");
  // A metà stub (46 giorni su 92) il rateo è metà dello stub, cioè un quarto di
  // cedola: 2,00 × 46/184 = 0,50.
  const mid = bonds.accruedInterest(stub, "2024-11-16");
  assert.equal(mid.periodStart, "2024-10-01");
  assert.equal(mid.days, 46);
  assert.equal(Number(mid.accruedPer100).toFixed(6), "0.500000");
  // Prima del godimento: nessun rateo (il titolo non esisteva).
  assert.equal(bonds.accruedInterest(stub, "2024-08-01").accruedPer100, "0");
});

test("zero coupon: nessuna cedola, solo il rimborso", () => {
  const zc = { couponRate: "0", couponFrequency: 0, maturityDate: "2030-01-01", faceValue: "1000" };
  assert.deepEqual(bonds.couponSchedule(zc), []);
  assert.deepEqual(bonds.accruedInterest(zc, "2027-06-15"), {
    accruedPer100: "0",
    periodStart: null,
    periodEnd: null,
    days: 0,
  });
  const ev = bonds.projectedEvents(zc, "2026-01-01");
  assert.equal(ev.length, 1);
  assert.equal(ev[0].kind, "REDEMPTION");
  assert.equal(ev[0].amountPerUnit, "100");
});

test("rateo ACT/ACT-ICMA a metà periodo ≈ metà cedola", () => {
  // Periodo 2025-01-01 → 2025-07-01 = 181 giorni. Il giorno 91 è appena oltre la
  // metà: 1,725 × 91/181.
  const a = bonds.accruedInterest(BTP, "2025-04-02");
  assert.equal(a.periodStart, "2025-01-01");
  assert.equal(a.periodEnd, "2025-07-01");
  assert.equal(a.days, 91);
  const expected = (1.725 * 91) / 181;
  assert.ok(
    Math.abs(Number(a.accruedPer100) - expected) < 1e-9,
    `atteso ~${expected}, ottenuto ${a.accruedPer100}`
  );
  // ...e resta sotto la cedola piena.
  assert.ok(Number(a.accruedPer100) < 1.725);
});

test("rateo NEL giorno di stacco = 0 (estremo destro escluso)", () => {
  // Il test che cattura l'off-by-one classico: nel giorno di pagamento la cedola
  // è staccata, il rateo riparte da zero.
  const a = bonds.accruedInterest(BTP, "2025-07-01");
  assert.equal(a.accruedPer100, "0");
  assert.equal(a.periodStart, "2025-07-01");
  assert.equal(a.days, 0);

  // Il giorno PRIMA è quasi la cedola intera, non zero.
  const before = bonds.accruedInterest(BTP, "2025-06-30");
  assert.ok(Number(before.accruedPer100) > 1.7);
  assert.ok(Number(before.accruedPer100) < 1.725);
});

test("rateo il primo giorno del periodo = 0", () => {
  const a = bonds.accruedInterest(BTP, "2025-01-01");
  assert.equal(a.accruedPer100, "0");
  assert.equal(a.days, 0);
});

test("rateo fuori dalla vita del titolo = 0", () => {
  assert.equal(bonds.accruedInterest(BTP, "2035-01-01").accruedPer100, "0"); // dopo la scadenza
  assert.equal(bonds.accruedInterest(BTP, "2000-01-01").accruedPer100, "0"); // prima dell'emissione
});

test("un periodo che contiene il 29 febbraio conta i giorni reali", () => {
  const b = {
    couponRate: "0.05",
    couponFrequency: 2,
    firstCouponDate: "2024-03-01",
    maturityDate: "2027-09-01",
    dayCount: "ACT/ACT-ICMA",
  };
  // Periodo 2023-09-01 → 2024-03-01 = 182 giorni (include il 29 feb 2024).
  const a = bonds.accruedInterest(b, "2024-02-29");
  assert.equal(a.periodStart, "2023-09-01");
  assert.equal(a.days, 181);
  const expected = (2.5 * 181) / 182;
  assert.ok(Math.abs(Number(a.accruedPer100) - expected) < 1e-9);
});

test("30E/360 tratta i mesi come 30 giorni", () => {
  assert.equal(bonds.days30E360("2026-01-01", "2026-02-01"), 30);
  assert.equal(bonds.days30E360("2026-01-31", "2026-02-28"), 28);
  assert.equal(bonds.days30E360("2026-01-01", "2027-01-01"), 360);
  const b = { ...BTP, dayCount: "30E/360" };
  // 3 mesi su base annua 360 = 90/360 = 1/4 di anno → 3,45 × 0,25 = 0,8625.
  const a = bonds.accruedInterest(b, "2025-04-01");
  assert.equal(Number(a.accruedPer100).toFixed(6), "0.862500");
});

test("ACT/365F usa i giorni reali su base 365", () => {
  const b = { ...BTP, dayCount: "ACT/365F" };
  const a = bonds.accruedInterest(b, "2025-04-02"); // 91 giorni
  const expected = (3.45 * 91) / 365;
  assert.ok(Math.abs(Number(a.accruedPer100) - expected) < 1e-9);
});

test("projectedEvents filtra il passato e chiude con il rimborso", () => {
  const ev = bonds.projectedEvents(BTP, "2026-08-04");
  assert.equal(ev[0].payDate, "2027-01-01", "le cedole già passate sono escluse");
  const last = ev[ev.length - 1];
  assert.equal(last.kind, "REDEMPTION");
  assert.equal(last.payDate, "2030-07-01");
  assert.equal(last.amountPerUnit, "100");
  // Tutte le cedole sono COUPON e portano l'importo per 100 di nominale.
  for (const e of ev.slice(0, -1)) {
    assert.equal(e.kind, "COUPON");
    assert.equal(e.amountPerUnit, "1.725");
  }
});

test("nominalOf e bondValue lavorano sul nominale, non sulla quantità", () => {
  // 10 titoli da 1000 nominali quotati 98,5 → 10.000 × 0,985 = 9.850.
  assert.equal(bonds.nominalOf("10", "1000").toFixed(), "10000");
  assert.equal(bonds.bondValue("10", "1000", "98.5").toFixed(), "9850");
  assert.equal(bonds.bondValue("10", "1000", "100").toFixed(), "10000");
  // faceValue 1 (default) → si comporta come un prezzo percentuale semplice.
  assert.equal(bonds.bondValue("100", "1", "99").toFixed(), "99");
});

test("currentYield = cedola annua / prezzo", () => {
  assert.equal(bonds.currentYield(BTP, "100"), "0.0345");
  // Sotto la pari il rendimento corrente sale.
  assert.equal(bonds.currentYield(BTP, "90"), "0.03833333");
  assert.equal(bonds.currentYield(BTP, "0"), null);
  assert.equal(bonds.currentYield({ couponRate: "0", couponFrequency: 0 }, "100"), null);
});

test("couponSchedule senza maturityDate lancia invece di indovinare", () => {
  assert.throws(() => bonds.couponSchedule({ couponFrequency: 2, couponRate: "0.03" }), TypeError);
});

test("frequenze annuale, trimestrale e mensile", () => {
  const mk = (f) =>
    bonds.couponSchedule({
      couponRate: "0.12",
      couponFrequency: f,
      firstCouponDate: f === 1 ? "2026-01-01" : f === 4 ? "2026-01-01" : "2026-01-01",
      maturityDate: "2027-01-01",
    });
  assert.equal(mk(1).length, 2);
  assert.equal(mk(1)[0].amountPer100, "12");
  assert.equal(mk(4).length, 5);
  assert.equal(mk(4)[0].amountPer100, "3");
  assert.equal(mk(12).length, 13);
  assert.equal(mk(12)[0].amountPer100, "1");
});
