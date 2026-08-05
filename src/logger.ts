// L'UNICO logger del processo. Sul branch `main` la piattaforma preloada
// @opentelemetry/auto-instrumentations-node/register, che strumenta pino per
// (a) iniettare trace_id/span_id e (b) spedire ogni record via OTLP.
//
// `console.log` NON viene inoltrato via OTLP: usare sempre questo logger.
// Vedi docs/decisions.md §10.
import pino from "pino";

const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  // Non loggare mai segreti, nemmeno se finiscono per sbaglio in un oggetto di
  // contesto. La redazione è a livello di logger, non del chiamante, perché
  // dipendere dalla disciplina del chiamante è come non averla.
  redact: {
    paths: [
      "password",
      "*.password",
      "req.body.password",
      "APP_PASSWORD",
      "SESSION_SECRET",
      "*.SESSION_SECRET",
      "PGPASSWORD",
      "DATABASE_URL",
      "cookie",
      "*.cookie",
      "headers.cookie",
      "headers.authorization",
    ],
    censor: "[redacted]",
  },
});

export default logger;
