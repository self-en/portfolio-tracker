// Guardie sulle assunzioni HTTP e sul montaggio dell'app.
//
// Esistono perché gli env di branch sono serviti su `http://` SEMPLICE, e le tre
// trappole qui sotto sono tutte silenziose: nessuna produce un errore lato server,
// tutte rompono l'app nel browser. Sono state trovate a mano con curl; questi test
// impediscono che tornino.
const test = require("node:test");
const assert = require("node:assert/strict");

process.env.APP_PASSWORD = "test-pw";
process.env.SESSION_SECRET = "0123456789abcdef0123456789abcdef0123456789";
process.env.PGHOST = "memdb";
process.env.SCHEDULER_ENABLED = "false";

const { freshMemDb } = require("../helpers/memdb");

let server;
let base;

test("setup", async () => {
  await freshMemDb();
  const boot = require("../../src/boot");
  boot.state.ready = true;
  boot.state.db.connected = true;
  const { buildApp } = require("../../src/app");
  server = await buildApp();
  base = await server.listen({ port: 0, host: "127.0.0.1" });
});

// ---------------------------------------------------------------------------
// Le tre direttive che assumono HTTPS
// ---------------------------------------------------------------------------

test("la CSP NON contiene upgrade-insecure-requests", async () => {
  // helmet la include PER DEFAULT. Su un host senza TLS ordina al browser di
  // riscrivere in https ogni richiesta della pagina: la SPA non carica un solo
  // asset, e il server non vede nemmeno arrivare le richieste — quindi nei log non
  // c'è niente da diagnosticare.
  const res = await fetch(`${base}/`);
  const csp = res.headers.get("content-security-policy") || "";
  assert.ok(csp.length > 0, "la CSP deve essere presente");
  assert.ok(
    !csp.includes("upgrade-insecure-requests"),
    `upgrade-insecure-requests è nella CSP: romperebbe l'env http://\n${csp}`
  );
});

test("nessun header HSTS", async () => {
  // HSTS manderebbe il browser a cercare https per mesi, su un host che non lo serve
  // — e il danno sopravvive alla correzione, perché è il browser a ricordarselo.
  const res = await fetch(`${base}/`);
  assert.equal(res.headers.get("strict-transport-security"), null);
});

test("il cookie di sessione NON ha Secure per default, ma ha HttpOnly e SameSite", async () => {
  const res = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "test-pw" }),
  });
  assert.equal(res.status, 204);
  const cookie = res.headers.getSetCookie()[0];
  assert.ok(cookie, "il login deve impostare un cookie");
  assert.ok(
    !/;\s*Secure/i.test(cookie),
    `il cookie ha Secure: su http:// il browser lo scarta in silenzio → 401 su tutto\n${cookie}`
  );
  assert.match(cookie, /HttpOnly/i, "HttpOnly è obbligatorio");
  assert.match(cookie, /SameSite=Lax/i, "SameSite=Lax è ciò che rende superfluo un token CSRF");
  assert.match(cookie, /Path=\//);
});

// ---------------------------------------------------------------------------
// Montaggio: la SPA non deve oscurare l'API
// ---------------------------------------------------------------------------

test("/healthz risponde 200 e NON è autenticato", async () => {
  const res = await fetch(`${base}/healthz`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: "ok" });
});

test("il fallback SPA serve le rotte client ma NON tocca /api né /healthz", async () => {
  for (const path of ["/", "/movimenti", "/calendario", "/strumenti/1", "/login"]) {
    const res = await fetch(`${base}${path}`);
    assert.equal(res.status, 200, `${path} deve servire la SPA`);
    assert.match(
      res.headers.get("content-type") || "",
      /text\/html/,
      `${path} deve restituire html`
    );
  }

  // Un endpoint /api inesistente NON deve ricevere index.html con status 200: la SPA
  // interpreterebbe l'HTML come JSON e fallirebbe in modo incomprensibile.
  const api = await fetch(`${base}/api/questo-non-esiste`);
  assert.notEqual(api.status, 200);
  assert.match(api.headers.get("content-type") || "", /application\/json/);

  const health = await fetch(`${base}/healthz`);
  assert.match(health.headers.get("content-type") || "", /application\/json/);
});

test("un asset MANCANTE dà 404, non index.html con status 200", async () => {
  // Senza l'esclusione di /assets/ dal fallback SPA, un bundle mancante — index.html
  // in cache che punta a un asset di un deploy precedente — riceverebbe HTML con
  // status 200. Il browser proverebbe a eseguirlo come JavaScript e fallirebbe con
  // "Unexpected token '<'", un errore che non nomina né il file né la causa.
  const res = await fetch(`${base}/assets/questo-bundle-non-esiste.js`);
  assert.equal(res.status, 404);
  assert.ok(
    !/text\/html/.test(res.headers.get("content-type") || ""),
    "un asset mancante non deve restituire HTML"
  );
});

test("index.html è no-store, gli asset hashati sono immutable", async () => {
  // index.html punta ai bundle hashati: una copia in cache dopo un deploy servirebbe
  // riferimenti ad asset che non esistono più.
  const index = await fetch(`${base}/`);
  assert.match(index.headers.get("cache-control") || "", /no-store/);

  const fs = require("node:fs");
  const path = require("node:path");
  const assetsDir = path.join(__dirname, "..", "..", "web", "dist", "assets");
  if (!fs.existsSync(assetsDir)) return; // build assente: niente da verificare
  const asset = fs.readdirSync(assetsDir).find((f) => f.endsWith(".js"));
  if (!asset) return;
  const res = await fetch(`${base}/assets/${asset}`);
  assert.equal(res.status, 200);
  const cc = res.headers.get("cache-control") || "";
  assert.match(cc, /immutable/);
  assert.match(cc, /max-age=31536000/);
});

// ---------------------------------------------------------------------------
// Sicurezza di base
// ---------------------------------------------------------------------------

test("nessun header X-Powered-By", async () => {
  const res = await fetch(`${base}/healthz`);
  assert.equal(res.headers.get("x-powered-by"), null);
});

test("la CSP consente la SPA e vieta gli script inline", async () => {
  const res = await fetch(`${base}/`);
  const csp = res.headers.get("content-security-policy") || "";
  assert.match(csp, /script-src 'self'/);
  // 'unsafe-inline' su style-src è il prezzo di recharts; su script-src NO.
  assert.ok(
    !/script-src[^;]*unsafe-inline/.test(csp),
    "unsafe-inline su script-src vanificherebbe la CSP"
  );
  assert.match(csp, /style-src[^;]*'unsafe-inline'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /object-src 'none'/);
});

test("il rate limit sul login scatta e restituisce Retry-After", async () => {
  const attempts = [];
  for (let i = 0; i < 12; i++) {
    attempts.push(
      await fetch(`${base}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9" },
        body: JSON.stringify({ password: "sbagliata" }),
      })
    );
  }
  const limited = attempts.find((r) => r.status === 429);
  assert.ok(limited, "dopo 10 tentativi deve arrivare un 429");
  assert.ok(limited.headers.get("retry-after"), "il 429 deve portare Retry-After");
  const body = await limited.json();
  assert.equal(body.error.code, "rate_limited");
});

test("teardown", async () => {
  await server.close();
});
