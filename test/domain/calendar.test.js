const test = require("node:test");
const assert = require("node:assert/strict");
const cal = require("../../src/domain/calendar");

test("addDays attraversa i confini di mese e anno", () => {
  assert.equal(cal.addDays("2026-01-31", 1), "2026-02-01");
  assert.equal(cal.addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(cal.addDays("2026-03-01", -1), "2026-02-28");
  assert.equal(cal.addDays("2024-03-01", -1), "2024-02-29"); // bisestile
});

test("addDays è immune al DST (l'ora legale non sposta un giorno)", () => {
  // In Europa il DST scatta l'ultima domenica di marzo e ottobre. Con un Date in
  // fuso locale questi salti producono 23 o 25 ore e un off-by-one.
  assert.equal(cal.addDays("2026-03-28", 1), "2026-03-29");
  assert.equal(cal.addDays("2026-03-29", 1), "2026-03-30");
  assert.equal(cal.addDays("2026-10-24", 1), "2026-10-25");
  assert.equal(cal.addDays("2026-10-25", 1), "2026-10-26");
  assert.equal(cal.daysBetween("2026-03-29", "2026-03-30"), 1);
  assert.equal(cal.daysBetween("2026-10-25", "2026-10-26"), 1);
});

test("daysBetween conta i giorni di calendario, bisestili inclusi", () => {
  assert.equal(cal.daysBetween("2026-01-01", "2026-01-01"), 0);
  assert.equal(cal.daysBetween("2026-01-01", "2027-01-01"), 365);
  assert.equal(cal.daysBetween("2024-01-01", "2025-01-01"), 366); // 2024 bisestile
  assert.equal(cal.daysBetween("2026-02-01", "2026-01-01"), -31);
});

test("lastDayOfMonth e isEom gestiscono febbraio e i bisestili", () => {
  assert.equal(cal.lastDayOfMonth(2024, 2), 29);
  assert.equal(cal.lastDayOfMonth(2026, 2), 28);
  assert.equal(cal.lastDayOfMonth(2000, 2), 29); // divisibile per 400
  assert.equal(cal.lastDayOfMonth(1900, 2), 28); // divisibile per 100 ma non 400
  assert.equal(cal.isEom("2024-02-29"), true);
  assert.equal(cal.isEom("2026-02-28"), true);
  assert.equal(cal.isEom("2026-02-27"), false);
  assert.equal(cal.isEom("2026-04-30"), true);
});

test("addMonthsPreserveEom: fine mese resta fine mese", () => {
  assert.equal(cal.addMonthsPreserveEom("2026-01-31", 1), "2026-02-28");
  assert.equal(cal.addMonthsPreserveEom("2024-01-31", 1), "2024-02-29");
  assert.equal(cal.addMonthsPreserveEom("2026-02-28", 1), "2026-03-31");
  assert.equal(cal.addMonthsPreserveEom("2026-04-30", 2), "2026-06-30");
  assert.equal(cal.addMonthsPreserveEom("2026-11-30", 6), "2027-05-31");
});

test("addMonthsPreserveEom: il 29 febbraio di un bisestile", () => {
  assert.equal(cal.addMonthsPreserveEom("2024-02-29", 12), "2025-02-28");
  assert.equal(cal.addMonthsPreserveEom("2024-02-29", 48), "2028-02-29");
  assert.equal(cal.addMonthsPreserveEom("2024-02-29", 6), "2024-08-31");
});

test("addMonthsPreserveEom: un giorno infra-mese non diventa fine mese", () => {
  assert.equal(cal.addMonthsPreserveEom("2026-01-15", 1), "2026-02-15");
  assert.equal(cal.addMonthsPreserveEom("2026-07-01", 6), "2027-01-01");
  // Clamp: il 30 gennaio non esiste in febbraio, ma NON è fine mese in origine.
  assert.equal(cal.addMonthsPreserveEom("2026-01-30", 1), "2026-02-28");
});

test("addMonthsPreserveEom è simmetrica sui passi negativi e attraversa gli anni", () => {
  assert.equal(cal.addMonthsPreserveEom("2026-07-01", -6), "2026-01-01");
  assert.equal(cal.addMonthsPreserveEom("2026-01-01", -1), "2025-12-01");
  assert.equal(cal.addMonthsPreserveEom("2026-03-31", -13), "2025-02-28");
});

test("eachDay è inclusivo su entrambi gli estremi", () => {
  assert.deepEqual(cal.eachDay("2026-01-30", "2026-02-02"), [
    "2026-01-30",
    "2026-01-31",
    "2026-02-01",
    "2026-02-02",
  ]);
  assert.deepEqual(cal.eachDay("2026-01-01", "2026-01-01"), ["2026-01-01"]);
  assert.deepEqual(cal.eachDay("2026-01-02", "2026-01-01"), []);
});

test("normalizeDate estrae la parte UTC dagli istanti di Yahoo", () => {
  // Xetra apre alle 08:00Z, NYSE alle 13:30Z: in entrambi i casi la parte UTC
  // della data è la price_date corretta.
  assert.equal(cal.normalizeDate("2024-01-02T08:00:00.000Z"), "2024-01-02");
  assert.equal(cal.normalizeDate("2020-06-01T13:30:00.000Z"), "2020-06-01");
  assert.equal(cal.normalizeDate("2026-08-04"), "2026-08-04");
  assert.equal(cal.normalizeDate(new Date(Date.UTC(2026, 7, 4))), "2026-08-04");
  assert.equal(cal.normalizeDate(null), null);
  assert.equal(cal.normalizeDate(""), null);
  assert.equal(cal.normalizeDate("non-una-data"), null);
});

test("forwardFill riporta avanti attraverso un weekend", () => {
  // Venerdì 2026-01-02 quota 100; sabato e domenica non quotano.
  const rows = [
    { date: "2026-01-02", value: "100" },
    { date: "2026-01-05", value: "102" },
  ];
  const out = cal.forwardFill(cal.eachDay("2026-01-02", "2026-01-05"), rows);
  assert.deepEqual(
    out.map((o) => [o.date, o.value, o.filled]),
    [
      ["2026-01-02", "100", false],
      ["2026-01-03", "100", true], // sabato: ultima osservazione
      ["2026-01-04", "100", true], // domenica
      ["2026-01-05", "102", false],
    ]
  );
});

test("forwardFill NON fa back-fill: prima della prima osservazione il valore è null", () => {
  // È il caso più importante di tutto il file: un back-fill o uno zero qui
  // sembrerebbe un crollo del portafoglio invece di un buco nei dati.
  const rows = [{ date: "2026-01-03", value: "50" }];
  const out = cal.forwardFill(cal.eachDay("2026-01-01", "2026-01-04"), rows);
  assert.equal(out[0].value, null);
  assert.equal(out[1].value, null);
  assert.equal(out[2].value, "50");
  assert.equal(out[3].value, "50");
  assert.equal(out[0].sourceDate, null);
});

test("forwardFill non interpola mai (nessun valore inventato tra due osservazioni)", () => {
  const rows = [
    { date: "2026-01-01", value: "100" },
    { date: "2026-01-05", value: "200" },
  ];
  const out = cal.forwardFill(cal.eachDay("2026-01-01", "2026-01-05"), rows);
  assert.deepEqual(out.map((o) => o.value), ["100", "100", "100", "100", "200"]);
});

test("forwardFill accetta righe non ordinate e chiavi personalizzate", () => {
  const rows = [
    { price_date: "2026-01-05", close: "3" },
    { price_date: "2026-01-01", close: "1" },
  ];
  const out = cal.forwardFill(cal.eachDay("2026-01-01", "2026-01-05"), rows, {
    dateKey: "price_date",
    valueKey: "close",
  });
  assert.deepEqual(out.map((o) => o.value), ["1", "1", "1", "1", "3"]);
});

test("forwardFillLookup concorda con forwardFill", () => {
  const rows = [
    { date: "2026-01-02", value: "100" },
    { date: "2026-01-05", value: "102" },
  ];
  const dates = cal.eachDay("2026-01-01", "2026-01-07");
  const filled = cal.forwardFill(dates, rows);
  const at = cal.forwardFillLookup(rows);
  for (const f of filled) {
    const l = at(f.date);
    assert.equal(l.value, f.value, `disaccordo su ${f.date}`);
    assert.equal(l.sourceDate, f.sourceDate);
    assert.equal(l.filled, f.filled);
  }
});

test("buildGrid: giornaliero sotto l'anno, settimanale e mensile oltre", () => {
  const day = cal.buildGrid("2026-01-01", "2026-03-01", "auto");
  assert.equal(day.granularity, "day");
  assert.equal(day.dates.length, 60);

  const week = cal.buildGrid("2020-01-01", "2024-01-01", "auto");
  assert.equal(week.granularity, "week");
  // I punti intermedi sono venerdì (primo e ultimo sono forzati).
  for (const dt of week.dates.slice(1, -1)) assert.equal(cal.dayOfWeek(dt), 5);

  const month = cal.buildGrid("2000-01-01", "2026-01-01", "auto");
  assert.equal(month.granularity, "month");
  for (const dt of month.dates.slice(1, -1)) assert.equal(cal.isEom(dt), true);
});

test("buildGrid include sempre il primo e l'ultimo giorno (asOf non si perde)", () => {
  // 2026-08-04 è un martedì: senza il forzamento, un downsampling settimanale
  // perderebbe proprio il valore che l'utente legge come "oggi".
  const g = cal.buildGrid("2021-01-01", "2026-08-04", "week");
  assert.equal(g.dates[0], "2021-01-01");
  assert.equal(g.dates[g.dates.length - 1], "2026-08-04");
  assert.equal(cal.dayOfWeek("2026-08-04"), 2);
});

test("buildGrid rispetta il cap di punti", () => {
  const g = cal.buildGrid("1990-01-01", "2026-01-01", "day");
  assert.ok(g.dates.length <= cal.MAX_POINTS + 1, `${g.dates.length} punti`);
  assert.equal(g.dates[g.dates.length - 1], "2026-01-01");
});

test("resolveRange non parte prima della prima transazione", () => {
  const r = cal.resolveRange("ALL", "2026-08-04", "2025-03-10");
  assert.deepEqual(r, { from: "2025-03-10", to: "2026-08-04" });

  const ytd = cal.resolveRange("YTD", "2026-08-04", "2020-01-01");
  assert.deepEqual(ytd, { from: "2026-01-01", to: "2026-08-04" });

  // 1Y ma la prima transazione è di 3 mesi fa → si parte da quella.
  const clamped = cal.resolveRange("1Y", "2026-08-04", "2026-05-01");
  assert.equal(clamped.from, "2026-05-01");
});

test("le date malformate lanciano invece di produrre risultati silenziosamente sbagliati", () => {
  assert.throws(() => cal.addDays("04/08/2026", 1), TypeError);
  assert.throws(() => cal.toMs(undefined), TypeError);
  assert.throws(() => cal.daysBetween("2026-1-1", "2026-01-02"), TypeError);
});
