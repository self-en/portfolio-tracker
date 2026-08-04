// Serve la SPA compilata da web/dist. Montato DOPO tutte le route /api.
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const config = require("./config");
const logger = require("./logger");

const DIST = path.join(__dirname, "..", "web", "dist");
const INDEX = path.join(DIST, "index.html");

// Regex con negative lookahead invece di '*': si comporta identica su Express 4 e
// sopravvive a un futuro passaggio a Express 5, dove la semantica della wildcard
// nelle route è cambiata.
//
// `/assets/` è ESCLUSO dal fallback, e non è un dettaglio: senza l'esclusione, un
// bundle mancante (index.html in cache che punta a un asset di un deploy precedente)
// riceverebbe index.html con status 200. Il browser proverebbe a eseguire HTML come
// JavaScript e fallirebbe con "Unexpected token '<'" — un errore che non nomina né
// il file mancante né la causa. Un 404 onesto è diagnosticabile in un secondo.
const SPA_FALLBACK = /^(?!\/api\/|\/healthz|\/assets\/).*/;

function mountStatic(app) {
  const hasBuild = fs.existsSync(INDEX);

  if (!hasBuild) {
    // Warning e stub, NON un crash: `npm run dev:api` da solo è un flusso di
    // lavoro legittimo (la SPA gira su :5173 col proxy di Vite).
    logger.warn(
      { dist: DIST },
      "[static] web/dist assente: servo uno stub. Esegui `npm run build:web`."
    );
    app.get(SPA_FALLBACK, (_req, res) =>
      res
        .status(200)
        .type("html")
        .set("Cache-Control", "no-store")
        .send(
          `<!doctype html><html lang="it"><head><meta charset="utf-8">
<title>${config.repoName}</title>
<style>body{font-family:system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#0f172a;color:#e2e8f0}
.card{max-width:34rem;padding:2rem}code{background:#1e293b;padding:.15rem .4rem;border-radius:.3rem}
a{color:#7dd3fc}</style></head><body><div class="card">
<h1>${config.repoName}</h1>
<p>La SPA non è stata compilata: <code>web/dist</code> non esiste.</p>
<p>Esegui <code>npm run build:web</code>, oppure in sviluppo usa
<code>npm run dev:web</code> e apri <a href="http://localhost:5173">:5173</a>.</p>
<p>L'API risponde comunque su <code>/api</code> e <code>/healthz</code>.</p>
</div></body></html>`
        )
    );
    return;
  }

  // Gli asset di Vite hanno l'hash del contenuto nel nome → immutable, 1 anno.
  app.use(
    "/assets",
    express.static(path.join(DIST, "assets"), { immutable: true, maxAge: "1y" })
  );
  // Terminatore per /assets/: un file non trovato qui è un 404, non il fallback SPA.
  app.use("/assets", (_req, res) =>
    res.status(404).type("txt").set("Cache-Control", "no-store").send("asset non trovato")
  );
  // Tutto il resto (favicon, manifest, …) con cache breve.
  app.use(express.static(DIST, { index: false, maxAge: "5m" }));

  // Fallback del router lato client. no-store su index.html: è il file che punta
  // agli asset hashati, e una copia in cache dopo un deploy servirebbe riferimenti
  // a bundle che non esistono più.
  app.get(SPA_FALLBACK, (_req, res) =>
    res.set("Cache-Control", "no-store").sendFile(INDEX)
  );

  logger.info({ dist: DIST }, "[static] SPA montata");
}

module.exports = { mountStatic, DIST, SPA_FALLBACK };
