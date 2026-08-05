import Fastify, { type FastifyInstance } from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyHelmet from "@fastify/helmet";
import config from "./config";
import logger from "./logger";
import { errorHandler } from "./http/errors";
import { createLimiter } from "./http/rateLimit";
import { buildApiRouter } from "./http/routes";
import { mountStatic } from "./static";

/**
 * Costruisce l'app. Restituisce un'istanza Fastify NON ancora in ascolto: chi
 * chiama fa `await app.ready()` (o `listen`), che è anche il momento in cui i
 * plugin registrati qui vengono effettivamente caricati.
 */
async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    // Dietro il Gateway Envoy: fidarsi di X-Forwarded-* per avere req.ip corretto
    // (serve al rate limiter) e req.protocol coerente.
    trustProxy: true,
    // 12mb: POST /api/import porta un dump intero.
    bodyLimit: 12 * 1024 * 1024,
    // Il logger del processo è UNO SOLO ed è src/logger.ts, con la sua redazione
    // dei segreti: quello integrato di Fastify lo affiancherebbe con un secondo
    // pino non redatto. I log di accesso li scrive l'hook onResponse qui sotto.
    logger: false,
    // Fastify non manda X-Powered-By, quindi non c'è nulla da disabilitare (in
    // Express serviva app.disable("x-powered-by")).
  });

  // PRIMA di ogni register, e non e' uno stile: in Fastify setErrorHandler vale
  // per il contesto in cui viene chiamato e per i figli creati DOPO. Con i plugin
  // registrati con await (quindi caricati subito), chiamarlo alla fine lo avrebbe
  // lasciato fuori dai contesti delle route: gli errori API sarebbero usciti con
  // la forma di default di Fastify ({statusCode, error, message}) invece della
  // nostra ({error:{code,message,details}}). Preso da un test di computed.test.js.
  app.setErrorHandler(errorHandler);

  await app.register(fastifyHelmet, {
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
  });

  await app.register(fastifyCookie);

  // Log di accesso strutturato, nella forma dello scaffold. Su `main` ogni riga
  // diventa un record OTLP che porta il trace context della richiesta (si salta da
  // un trace ai suoi log in Grafana), es. "GET /healthz 200 0.4ms".
  //
  // NON logga il body: va tenuto così, è ciò che impedisce alla password di finire
  // nei log — il redact del logger è la seconda rete, non la prima.
  app.addHook("onResponse", async (req, reply) => {
    const url = req.url;
    const isAsset = /^\/(assets\/|favicon|robots\.txt|manifest)/.test(url);
    // Gli asset statici andati a buon fine scendono a `debug`. Lo scaffold serviva
    // una sola pagina; una SPA chiede bundle, mappe e favicon a ogni caricamento, e
    // su `main` OGNI riga diventa un record OTLP — il rumore seppellirebbe le
    // richieste che contano. Tutto ciò che non è 2xx resta a `info`, così un asset
    // mancante o un 500 non si nasconde mai.
    const quiet = isAsset && reply.statusCode < 400;
    const log = quiet ? logger.debug.bind(logger) : logger.info.bind(logger);
    const ms = reply.elapsedTime;
    log(
      { method: req.method, path: url, status: reply.statusCode, durationMs: Number(ms.toFixed(1)) },
      `${req.method} ${url} ${reply.statusCode} ${ms.toFixed(1)}ms`
    );
  });

  // Probe di readiness della piattaforma. Invariato e NON autenticato.
  // Resta 200 anche in locked mode o con il DB giù, di proposito: se restituisse
  // 503 la piattaforma ricreerebbe il pod in loop e i log diventerebbero
  // illeggibili proprio quando servono. La diagnostica vive in
  // /api/system/status.
  app.get("/healthz", async () => ({ status: "ok" }));

  // Limite globale, cintura di sicurezza contro un client impazzito. Solo su /api:
  // in Express era `app.use("/api", …)`, qui l'hook è globale e filtra sul path.
  const globalLimiter = createLimiter({
    windowMs: 60_000,
    max: config.limits.globalPerMinute,
    name: "global",
  });
  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/api")) return;
    return globalLimiter.hook(req, reply);
  });

  await app.register(buildApiRouter, { prefix: "/api" });

  // La SPA va registrata DOPO tutte le route /api: il suo fallback (il
  // notFoundHandler) esclude /api e /healthz.
  await mountStatic(app);

  return app;
}

export { buildApp };
