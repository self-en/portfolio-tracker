// Bootstrap sottile. Tutta la sostanza vive in src/.
//
// Observability: sul solo branch `main` la piattaforma imposta NODE_OPTIONS per
// preloadare build/instrumentation.js, che dà TRACE (http/fastify/pg) e METRICHE
// senza codice applicativo. L'unico segnale che non può emettere da solo sono i
// LOG: fa da bridge a pino, ma NON a `console.log`. Per questo l'app logga
// attraverso `src/logger.ts` — e per questo `console.log` è vietato in tutto src/
// (vedi docs/decisions.md §10).
import logger from "./logger";
import config from "./config";
import { buildApp } from "./app";
import { start } from "./boot";
import { close as closePool } from "./db/pool";
import { errMessage, errStack } from "./util/err";

async function main(): Promise<void> {
  const app = await buildApp();

  // NOTA L'ORDINE: prima listen(), poi le migrazioni. Il pod deve diventare
  // raggiungibile anche se il DB non è pronto — il job PreSync che crea il
  // database può essere ancora in corso — altrimenti una migrazione fallita
  // produce un crashloop senza modo di leggere i log dalla UI della piattaforma.
  await app.listen({ port: config.port, host: "0.0.0.0" });
  logger.info(`[app] listening on :${config.port}`);

  void start();

  let closing = false;
  function shutdown(signal: string): void {
    if (closing) return;
    closing = true;
    logger.info({ signal }, "[app] arresto in corso");
    void app
      .close()
      .then(() => closePool())
      .finally(() => process.exit(0));
    // Se le connessioni non si chiudono entro 10s, si esce comunque: Kubernetes
    // manderebbe SIGKILL poco dopo.
    setTimeout(() => process.exit(0), 10_000).unref();
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

// Su questa piattaforma un crash è inosservabile: si logga e si resta su.
process.on("unhandledRejection", (reason) =>
  logger.error({ err: errMessage(reason) }, "[app] unhandled rejection")
);
process.on("uncaughtException", (err) =>
  logger.error({ err: errMessage(err), stack: errStack(err) }, "[app] uncaught exception")
);

void main().catch((err) => {
  // Un fallimento di listen() (porta occupata) è l'unico caso in cui non si può
  // restare su: senza socket non c'è niente da servire, e Kubernetes deve vederlo.
  logger.error({ err: errMessage(err), stack: errStack(err) }, "[app] avvio fallito");
  process.exit(1);
});
