// Bootstrap sottile. Tutta la sostanza vive in src/.
//
// Observability: sul solo branch `main` la piattaforma imposta NODE_OPTIONS per
// preloadare @opentelemetry/auto-instrumentations-node/register, che dà TRACE
// (http/express/pg) e METRICHE senza codice. L'unico segnale che non può emettere
// da solo sono i LOG applicativi: fa da bridge a pino/winston/bunyan, ma NON a
// `console.log`. Per questo l'app logga attraverso `src/logger.js` — e per questo
// `console.log` è vietato in tutto src/ (vedi docs/decisions.md §10).
const logger = require("./src/logger");
const config = require("./src/config");
const { buildApp } = require("./src/app");
const { start } = require("./src/boot");

const app = buildApp();

const server = app.listen(config.port, () =>
  logger.info(`[app] listening on :${config.port}`)
);

// NOTA L'ORDINE: prima listen(), poi le migrazioni. Il pod deve diventare
// raggiungibile anche se il DB non è pronto — il job PreSync che crea il database
// può essere ancora in corso — altrimenti una migrazione fallita produce un
// crashloop senza modo di leggere i log dalla UI della piattaforma.
void start();

function shutdown(signal) {
  logger.info({ signal }, "[app] arresto in corso");
  server.close(() => {
    require("./src/db/pool")
      .close()
      .finally(() => process.exit(0));
  });
  // Se le connessioni non si chiudono entro 10s, si esce comunque: Kubernetes
  // manderebbe SIGKILL poco dopo.
  setTimeout(() => process.exit(0), 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// Su questa piattaforma un crash è inosservabile: si logga e si resta su.
process.on("unhandledRejection", (reason) =>
  logger.error({ err: reason?.message || String(reason) }, "[app] unhandled rejection")
);
process.on("uncaughtException", (err) =>
  logger.error({ err: err?.message, stack: err?.stack }, "[app] uncaught exception")
);
