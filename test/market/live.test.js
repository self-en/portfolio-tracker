// Test LIVE contro Yahoo e Frankfurter reali. Opt-in: `LIVE=1 node --test ...`.
//
// Sono esclusi per default perché dipendono dalla rete e dal rate limit di un IP
// condiviso: un test che fallisce a caso è peggio di un test che non c'è. Servono
// per (a) rigenerare le fixture quando serve e (b) diagnosticare dall'interno del
// cluster se Yahoo blocca l'egress condiviso.
const test = require("node:test");
const assert = require("node:assert/strict");

process.env.APP_PASSWORD = "test";
process.env.SESSION_SECRET = "0123456789abcdef0123456789abcdef0123456789";

const LIVE = process.env.LIVE === "1";
const opts = { skip: LIVE ? false : "impostare LIVE=1 per interrogare le API reali" };

const { createYahooProvider } = require("../../src/market/yahooProvider");
const { createFxProvider } = require("../../src/market/fxProvider");
const config = require("../../src/config");

test("live: quote reale di EUNL.DE", opts, async () => {
  const p = createYahooProvider(config);
  const quotes = await p.getQuotes(["EUNL.DE"]);
  assert.equal(quotes.length, 1);
  assert.equal(quotes[0].symbol, "EUNL.DE");
  assert.ok(Number(quotes[0].price) > 0);
  assert.equal(quotes[0].currency, "EUR");
});

test("live: quoteCombine su più simboli non fallisce sul rate limit", opts, async () => {
  const p = createYahooProvider(config);
  const quotes = await p.getQuotes(["AAPL", "MSFT", "EUNL.DE", "VWCE.DE"]);
  assert.ok(quotes.length >= 3, `attese almeno 3 quotazioni, ottenute ${quotes.length}`);
  for (const q of quotes) assert.ok(Number(q.price) > 0);
});

test("live: storico con dividendi e split", opts, async () => {
  const p = createYahooProvider(config);
  const h = await p.getHistory("AAPL", "2020-06-01", "2021-03-01");
  assert.ok(h.bars.length > 100);
  assert.equal(h.currency, "USD");
  assert.ok(h.events.dividends.length >= 2);
  // Lo split 4:1 del 2020-08-31 deve comparire.
  const split = h.events.splits.find((s) => s.date === "2020-08-31");
  assert.ok(split, "lo split 4:1 di AAPL deve essere presente");
  assert.equal(split.ratio, "4");
  // E il close DEVE essere retro-aggiustato: molto sotto i ~322 realmente scambiati.
  assert.ok(
    Number(h.bars[0].close) < 150,
    "il close di Yahoo deve essere aggiustato per gli split (§3.4)"
  );
});

test("live: risoluzione ISIN → ticker", opts, async () => {
  const p = createYahooProvider(config);
  const items = await p.resolveSymbol("IE00B4L5Y983");
  assert.ok(items.length >= 1);
  assert.ok(items.some((i) => i.symbol === "IWDA.L"));
});

test("live: le obbligazioni NON hanno copertura (conferma la scelta manuale)", opts, async () => {
  const p = createYahooProvider(config);
  for (const isin of ["IT0005611741", "IT0005433195", "IT0005240830"]) {
    const items = await p.resolveSymbol(isin);
    assert.deepEqual(
      items,
      [],
      `${isin} ha copertura inattesa: rivalutare la scelta del pricing manuale`
    );
  }
});

test("live: Frankfurter v2 restituisce un array piatto, weekend inclusi", opts, async () => {
  const fx = createFxProvider(config);
  const { records, source } = await fx.getRates(["USD", "GBP"], {
    from: "2026-07-31",
    to: "2026-08-03",
  });
  assert.equal(source, "frankfurter");
  assert.ok(records.length >= 6);
  for (const r of records) {
    assert.equal(r.base, "EUR");
    assert.ok(Number(r.rate) > 0);
    assert.match(r.date, /^\d{4}-\d{2}-\d{2}$/);
  }
  // Il 2026-08-01 è un sabato: la v2 pubblica comunque.
  const dates = new Set(records.map((r) => r.date));
  assert.ok(dates.has("2026-08-01") || dates.has("2026-08-02"), "attesi tassi nel weekend");
});

test("live: un simbolo inesistente non fa esplodere getQuotes", opts, async () => {
  const p = createYahooProvider(config);
  // Deve degradare a lista vuota o parziale, non lanciare: un ticker sbagliato
  // inserito a mano non deve rompere il refresh degli altri.
  const quotes = await p.getQuotes(["QUESTO_NON_ESISTE_XYZ", "EUNL.DE"]);
  assert.ok(Array.isArray(quotes));
  assert.ok(quotes.every((q) => q.symbol !== "QUESTO_NON_ESISTE_XYZ"));
});
