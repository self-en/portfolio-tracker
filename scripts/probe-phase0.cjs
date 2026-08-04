/* eslint-disable no-console */
// Fase 0 — script di de-risk. NON è codice di prodotto: gira a mano, scrive su
// stderr e salva le risposte grezze in test/fixtures/. Usa console di proposito
// (è uno script CLI, non il processo server, dove console.* è vietato).
const fs = require("node:fs");
const path = require("node:path");

const FIX = path.join(__dirname, "..", "test", "fixtures");
const save = (rel, data) => {
  const p = path.join(FIX, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + "\n");
  console.error(`  → salvata fixture ${rel} (${fs.statSync(p).size} byte)`);
};

const calls = [];
const fakeLogger = {
  info: (...a) => calls.push(["info", a]),
  warn: (...a) => calls.push(["warn", a]),
  error: (...a) => calls.push(["error", a]),
  debug: (...a) => calls.push(["debug", a]),
  dir: (...a) => calls.push(["dir", a]),
};

async function main() {
  console.error("== 1. require CJS di yahoo-finance2 ==");
  const mod = require("yahoo-finance2");
  console.error("  typeof mod:", typeof mod, "| typeof mod.default:", typeof mod.default);
  const YahooFinance = mod.default;
  const yf = new YahooFinance({
    queue: { concurrency: 2, interval: 250 },
    validation: { logErrors: false, logOptionsErrors: true, allowAdditionalProps: true },
    versionCheck: false,
    logger: fakeLogger,
  });
  console.error(
    "  costruito OK. metodi:",
    ["quote", "quoteCombine", "chart", "quoteSummary", "search"]
      .map((m) => `${m}=${typeof yf[m]}`)
      .join(" ")
  );
  console.error("  chiamate al logger in costruzione:", JSON.stringify(calls));

  console.error("\n== 2. quote(EUNL.DE) ==");
  try {
    const q = await yf.quote("EUNL.DE");
    console.error(`  ${q.symbol} ${q.regularMarketPrice} ${q.currency} state=${q.marketState}`);
    save("yahoo/quote-EUNL.DE.json", q);
  } catch (e) {
    console.error("  FALLITO:", e.name, e.message);
    if (e.result) save("yahoo/quote-EUNL.DE.drifted.json", { errors: e.errors, result: e.result });
  }

  console.error("\n== 3. chart(EUNL.DE) con events div|split ==");
  try {
    const c = await yf.chart("EUNL.DE", {
      period1: "2024-01-01",
      period2: "2024-06-30",
      interval: "1d",
      events: "div|split",
      return: "array",
    });
    console.error(
      `  meta.currency=${c.meta?.currency} meta.symbol=${c.meta?.symbol} quotes=${c.quotes?.length} events=${JSON.stringify(Object.keys(c.events || {}))}`
    );
    console.error("  prima barra:", JSON.stringify(c.quotes?.[0]));
    save("yahoo/chart-EUNL.DE.json", c);
  } catch (e) {
    console.error("  FALLITO:", e.name, e.message);
    if (e.result) save("yahoo/chart-EUNL.DE.drifted.json", { errors: e.errors, result: e.result });
  }

  console.error("\n== 4. search(IE00B4L5Y983) — ISIN → ticker ==");
  try {
    const s = await yf.search("IE00B4L5Y983");
    console.error(
      "  quotes:",
      (s.quotes || []).map((q) => `${q.symbol}/${q.exchange}/${q.quoteType}`).join(", ") || "(vuoto)"
    );
    save("yahoo/search-IE00B4L5Y983.json", s);
  } catch (e) {
    console.error("  FALLITO:", e.name, e.message);
    if (e.result) save("yahoo/search-IE00B4L5Y983.drifted.json", { errors: e.errors, result: e.result });
  }

  console.error("\n== 5. quoteSummary(EUNL.DE) calendarEvents+summaryDetail ==");
  try {
    const qs = await yf.quoteSummary("EUNL.DE", { modules: ["calendarEvents", "summaryDetail"] });
    console.error("  moduli:", Object.keys(qs).join(", "));
    save("yahoo/quoteSummary-EUNL.DE.json", qs);
  } catch (e) {
    console.error("  FALLITO:", e.name, e.message);
    if (e.result) save("yahoo/quoteSummary-EUNL.DE.drifted.json", { errors: e.errors, result: e.result });
  }

  console.error("\n== 6. copertura obbligazioni: search sugli ISIN dei BTP ==");
  const bondIsins = ["IT0005611741", "IT0005433195", "IT0005240830"];
  const bondResults = {};
  for (const isin of bondIsins) {
    try {
      const r = await yf.search(isin);
      bondResults[isin] = (r.quotes || []).map((q) => q.symbol);
      console.error(`  ${isin} → quotes: ${JSON.stringify(bondResults[isin])}`);
    } catch (e) {
      bondResults[isin] = { error: e.name };
      console.error(`  ${isin} → FALLITO ${e.name}`);
    }
  }
  save("yahoo/search-bonds.json", bondResults);

  console.error("\n== 7. Frankfurter v2 — forma della risposta ==");
  for (const [label, url] of [
    ["single", "https://api.frankfurter.dev/v2/rates?base=EUR&quotes=USD,GBP,CHF"],
    [
      "range",
      "https://api.frankfurter.dev/v2/rates?from=2026-07-30&to=2026-08-03&base=EUR&quotes=USD,GBP",
    ],
  ]) {
    try {
      const res = await fetch(url);
      const body = await res.json();
      console.error(`  ${label}: status=${res.status} isArray=${Array.isArray(body)}`);
      console.error(`  ${label}: ${JSON.stringify(Array.isArray(body) ? body.slice(0, 4) : body).slice(0, 300)}`);
      save(`fx/frankfurter-v2-${label}.json`, body);
    } catch (e) {
      console.error(`  ${label} FALLITO:`, e.message);
    }
  }

  console.error("\n== 8. sanity ICU / timezone ==");
  console.error("  Intl Europe/Rome:", new Date(1754308800000).toLocaleString("it-IT", { timeZone: "Europe/Rome" }));
  console.error("  process.env.TZ:", JSON.stringify(process.env.TZ));

  console.error("\nFatto.");
}

main().catch((e) => {
  console.error("PROBE FALLITO:", e);
  process.exit(1);
});
