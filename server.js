// Minimal starter app scaffolded by the self-en platform. Serves a landing page
// and a /healthz probe, and (if a database is wired) does a one-off SELECT 1 at
// startup without crashing if the DB is unreachable.
//
// Observability: on the `main` branch the platform sets NODE_OPTIONS to preload
// @opentelemetry/auto-instrumentations-node/register (see chart/deployment.yaml
// + package.json). That register hook alone gives you TRACES (http/express/pg)
// and METRICS (nodejs runtime + http server) exported over OTLP, zero code.
// The one signal it can't emit on its own is application LOGS: it bridges
// pino/winston/bunyan to OTLP, but NOT bare `console.log`. So this app logs
// through `pino` below - which the register hook auto-instruments to (a) inject
// trace_id/span_id (log<->trace correlation) and (b) send every log record to
// the OTLP collector, on top of pino's normal JSON-on-stdout (kept so the
// node-log tailing path keeps working too). Result: traces, metrics AND logs
// all flow, and on non-main branches (NODE_OPTIONS unset) pino simply writes
// JSON to stdout with none of the OTel machinery loaded.
const express = require("express");
const pino = require("pino");

const logger = pino({ level: process.env.LOG_LEVEL || "info" });

const app = express();
const port = Number(process.env.PORT) || 3000;
const repo = process.env.REPO_NAME || "portfolio-tracker";

// Structured per-request access log. Emitted through pino, so on `main` each
// line becomes an OTLP log record carrying the active request's trace context
// (jump straight from a trace to its logs in Grafana), e.g. "GET /healthz 200 0.4ms".
app.use((req, res, next) => {
  const start = process.hrtime.bigint();
  res.on("finish", () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    logger.info(
      { method: req.method, path: req.originalUrl, status: res.statusCode, durationMs: Number(ms.toFixed(1)) },
      `${req.method} ${req.originalUrl} ${res.statusCode} ${ms.toFixed(1)}ms`
    );
  });
  next();
});

app.get("/healthz", (_req, res) => res.json({ status: "ok" }));

app.get("/", (_req, res) => {
  res
    .type("html")
    .send(
      `<!doctype html>
<html lang="it">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${repo}</title>
    <style>
      body { font-family: system-ui, sans-serif; margin: 0; display: grid; place-items: center; min-height: 100vh; background: #0f172a; color: #e2e8f0; }
      .card { text-align: center; padding: 2rem 3rem; }
      h1 { margin: 0 0 .5rem; font-size: 2rem; }
      p { margin: .25rem 0; color: #94a3b8; }
      code { background: #1e293b; padding: .15rem .4rem; border-radius: .3rem; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>Ciao da ${repo} 👋</h1>
      <p>Questa versione è stata creata dalla piattaforma self-en.</p>
      <p>Modifica <code>server.js</code> e fai push: la tua versione si aggiorna da sola.</p>
    </div>
  </body>
</html>`
    );
});

app.listen(port, () => logger.info(`[app] listening on :${port}`));

// Best-effort DB connectivity check. Prefers discrete PG* env vars (set by the
// chart) to avoid URL-encoding issues; falls back to DATABASE_URL. Never crashes
// the process - an env should come up even if the DB isn't ready yet.
async function checkDb() {
  const hasDiscrete = !!process.env.PGHOST;
  const hasUrl = !!process.env.DATABASE_URL;
  if (!hasDiscrete && !hasUrl) return;
  try {
    const { Pool } = require("pg");
    const pool = hasDiscrete ? new Pool() : new Pool({ connectionString: process.env.DATABASE_URL });
    await pool.query("SELECT 1");
    logger.info("[app] database connection ok");
    await pool.end();
  } catch (err) {
    logger.error("[app] database check failed (continuing): " + err.message);
  }
}

void checkDb();
