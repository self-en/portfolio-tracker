const express = require("express");
const cookieParser = require("cookie-parser");
const helmet = require("helmet");
const config = require("./config");
const logger = require("./logger");
const { errorHandler } = require("./http/errors");
const { createLimiter } = require("./http/rateLimit");
const { buildApiRouter } = require("./http/routes");
const { mountStatic } = require("./static");

function buildApp() {
  const app = express();

  // Dietro il Gateway Envoy: fidarsi di X-Forwarded-* per avere req.ip corretto
  // (serve al rate limiter) e req.protocol coerente.
  app.set("trust proxy", true);
  app.disable("x-powered-by");

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          // Vite e recharts iniettano stili inline: 'unsafe-inline' su style-src è
          // il prezzo, e resta molto meno grave che su script-src.
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", "data:"],
          connectSrc: ["'self'"],
          fontSrc: ["'self'", "data:"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          frameAncestors: ["'none'"],
          formAction: ["'self'"],
          // upgrade-insecure-requests DISATTIVATO (helmet lo mette per default).
          //
          // Stessa trappola del cookie Secure, e altrettanto silenziosa: gli env di
          // branch sono serviti su http:// semplice, e questa direttiva ordina al
          // browser di riscrivere in https OGNI richiesta della pagina. Su un host
          // senza TLS il risultato è una pagina bianca con tutti gli asset falliti.
          // Va riattivata il giorno in cui la piattaforma aggiunge TLS.
          upgradeInsecureRequests: null,
        },
      },
      // Gli env di branch sono su http:// semplice: HSTS manderebbe il browser a
      // cercare https per mesi, su un host che non lo serve.
      hsts: false,
      // COEP rompe il caricamento di asset senza CORP per zero beneficio qui.
      crossOriginEmbedderPolicy: false,
    })
  );

  // Log di accesso strutturato, nella forma dello scaffold. Su `main` ogni riga
  // diventa un record OTLP che porta il trace context della richiesta (si salta da un
  // trace ai suoi log in Grafana), es. "GET /healthz 200 0.4ms".
  //
  // NON logga il body: va tenuto così, è ciò che impedisce alla password di finire
  // nei log — il redact del logger è la seconda rete, non la prima.
  app.use((req, res, next) => {
    const start = process.hrtime.bigint();
    // Il percorso va catturato ORA, non dentro l'handler `finish`: un
    // `app.use("/assets", …)` riscrive temporaneamente `req.url` togliendo il
    // prefisso di mount, e l'evento `finish` può arrivare prima che venga
    // ripristinato — a quel punto `req.path` è "/index-abc.js" e qualsiasi controllo
    // sul prefisso fallisce in silenzio.
    const method = req.method;
    const url = req.originalUrl;
    const isAsset = /^\/(assets\/|favicon|robots\.txt|manifest)/.test(req.path);

    res.on("finish", () => {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      // Gli asset statici andati a buon fine scendono a `debug`. Lo scaffold serviva
      // una sola pagina; una SPA chiede bundle, mappe e favicon a ogni caricamento, e
      // su `main` OGNI riga diventa un record OTLP — il rumore seppellirebbe le
      // richieste che contano. Tutto ciò che non è 2xx resta a `info`, così un asset
      // mancante o un 500 non si nasconde mai.
      const quiet = isAsset && res.statusCode < 400;
      const log = quiet ? logger.debug.bind(logger) : logger.info.bind(logger);
      log(
        { method, path: url, status: res.statusCode, durationMs: Number(ms.toFixed(1)) },
        `${method} ${url} ${res.statusCode} ${ms.toFixed(1)}ms`
      );
    });
    next();
  });

  // Probe di readiness della piattaforma. Invariato e NON autenticato.
  // Resta 200 anche in locked mode o con il DB giù, di proposito: se restituisse
  // 503 la piattaforma ricreerebbe il pod in loop e i log diventerebbero
  // illeggibili proprio quando servono. La diagnostica vive in
  // /api/system/status.
  app.get("/healthz", (_req, res) => res.json({ status: "ok" }));

  app.use(express.json({ limit: "12mb" })); // 12mb: POST /api/import porta un dump intero
  app.use(cookieParser());

  // Limite globale, cintura di sicurezza contro un client impazzito.
  const globalLimiter = createLimiter({
    windowMs: 60_000,
    max: config.limits.globalPerMinute,
    name: "global",
  });
  app.use("/api", globalLimiter.middleware);

  app.use("/api", buildApiRouter());

  // La SPA va montata DOPO tutte le route /api, e il suo fallback esclude
  // /api e /healthz con un negative lookahead.
  mountStatic(app);

  app.use(errorHandler);

  return app;
}

module.exports = { buildApp };
