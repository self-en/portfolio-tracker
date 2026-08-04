/* eslint-disable no-console */
// Fase 0, seconda passata: cattura le fixture per i casi che la prima non copriva.
//
// Serviva perché `EUNL.DE` non ha dividendi né split nel periodo richiesto, quindi
// la sua risposta non dice NULLA su come Yahoo rappresenta quegli eventi. AAPL sì:
// tre dividendi e lo split 4:1 del 2020-08-31.
//
// Le due scoperte che hanno cambiato il codice:
//   1. il `close` del 2020-06-01 è 80,46 mentre il prezzo realmente scambiato era
//      ~322 → la serie è RETRO-AGGIUSTATA per gli split (docs/decisions.md §4)
//   2. `events.splits[]` porta {numerator, denominator, splitRatio:"4:1"}, e la
//      chiave `events` è ASSENTE quando nel periodo non ci sono eventi
//
// Come la prima passata: script CLI, `console` di proposito (non è il processo
// server, dove console.* è vietato). Rigirarlo sovrascrive le fixture.
const fs = require("node:fs");
const path = require("node:path");

const YahooFinance = require("yahoo-finance2").default;

// Logger silenzioso: qui interessa il payload, non la diagnostica della libreria.
const silent = { info() {}, warn() {}, error() {}, debug() {}, dir() {} };

const yf = new YahooFinance({
  versionCheck: false,
  validation: { logErrors: false, allowAdditionalProps: true },
  logger: silent,
});

function save(rel, data) {
  const p = path.join(__dirname, "..", "test", "fixtures", rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + "\n");
  console.error(`  → salvata ${rel} (${fs.statSync(p).size} byte)`);
}

async function main() {
  console.error("== chart(AAPL) con dividendi E split 4:1 ==");
  const chart = await yf.chart("AAPL", {
    period1: "2020-06-01",
    period2: "2021-03-01",
    interval: "1d",
    events: "div|split",
    return: "array",
  });
  console.error("  chiavi di events:", JSON.stringify(Object.keys(chart.events || {})));
  console.error("  split:", JSON.stringify(chart.events?.splits));
  console.error("  prima barra:", JSON.stringify(chart.quotes[0]));
  console.error(
    `  → close ${chart.quotes[0].close} contro ~322 realmente scambiati: serie retro-aggiustata`
  );
  save("yahoo/chart-AAPL-splitdiv.json", chart);

  console.error("\n== quoteCombine su più simboli (collassa in una richiesta) ==");
  const quotes = await Promise.all(
    ["AAPL", "MSFT", "EUNL.DE"].map((s) => yf.quoteCombine(s))
  );
  console.error(
    "  " + quotes.map((q) => `${q.symbol}=${q.regularMarketPrice}${q.currency}`).join(" ")
  );
  save("yahoo/quoteCombine-multi.json", quotes);

  console.error("\n== quoteSummary(AAPL): calendarEvents PRESENTE ==");
  const summary = await yf.quoteSummary("AAPL", {
    modules: ["calendarEvents", "summaryDetail"],
  });
  console.error("  moduli restituiti:", Object.keys(summary).join(", "));
  console.error(
    `  exDividendDate=${summary.calendarEvents?.exDividendDate} dividendDate=${summary.calendarEvents?.dividendDate}`
  );
  console.error("  (su EUNL.DE lo stesso modulo è OMESSO: mai assumere che ci sia)");
  save("yahoo/quoteSummary-AAPL.json", summary);

  console.error("\nFatto.");
}

main().catch((e) => {
  console.error("PROBE FALLITO:", e.name, e.message);
  // Se è drift di validazione, l'errore porta il payload coercito: è esattamente
  // l'escape hatch che src/market/tolerant.js sfrutta.
  if (e.result) console.error("  err.result presente ✓ → tolerant() lo recupererebbe");
  process.exit(1);
});
