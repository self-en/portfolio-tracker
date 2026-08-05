// Parsing dell'env + rilevamento del locked mode.
//
// Principio guida: NON CRASHARE MAI AL BOOT. Su questa piattaforma un crashloop
// significa nessun log nella UI e nessun modo di diagnosticare. Una config
// mancante degrada in "locked mode": il processo serve /healthz (200, così la
// readiness della piattaforma è soddisfatta e i log restano leggibili) e
// risponde 503 not_configured su ogni /api/*.
import logger from "./logger";

const MIN_SECRET_LEN = 32;

function bool(v: string | undefined, dflt = false): boolean {
  if (v === undefined || v === "") return dflt;
  return v === "true" || v === "1" || v === "yes";
}

function int(v: string | undefined, dflt: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

function build() {
  const problems = [];

  const appPassword = process.env.APP_PASSWORD || "";
  const sessionSecret = process.env.SESSION_SECRET || "";

  if (!appPassword) {
    problems.push("APP_PASSWORD non impostata");
  }
  if (!sessionSecret) {
    problems.push("SESSION_SECRET non impostata");
  } else if (sessionSecret.length < MIN_SECRET_LEN) {
    problems.push(
      `SESSION_SECRET troppo corta (${sessionSecret.length} caratteri, minimo ${MIN_SECRET_LEN})`
    );
  }

  // NON auto-generiamo SESSION_SECRET: invaliderebbe in silenzio ogni sessione a
  // ogni deploy, nascondendo la misconfigurazione dietro un "ogni tanto devo
  // rifare il login". Meglio un locked mode rumoroso.

  const hasDiscretePg = !!process.env.PGHOST;
  const hasPgUrl = !!process.env.DATABASE_URL;

  const config = {
    port: int(process.env.PORT, 3000),
    repoName: process.env.REPO_NAME || "portfolio-tracker",
    nodeEnv: process.env.NODE_ENV || "development",
    // Il fuso del PROCESSO (il container gira in UTC): serve solo alla
    // diagnostica, ma passa da qui come ogni altra variabile.
    tz: process.env.TZ || null,

    locked: problems.length > 0,
    lockedReasons: problems,

    auth: {
      appPassword,
      sessionSecret,
      cookieName: process.env.COOKIE_NAME || "pt_session",
      // Gli env di branch sono serviti su http:// semplice (httproute.yaml non ha
      // configurazione TLS) e un cookie Secure viene scartato in silenzio dal
      // browser: login 204 seguito da 401 su tutto, senza nulla nei log.
      // Default false. Passa a true il giorno in cui la piattaforma aggiunge TLS.
      cookieSecure: bool(process.env.COOKIE_SECURE, false),
      sessionTtlDays: int(process.env.SESSION_TTL_DAYS, 30),
      // Rinnovo scorrevole quando restano meno di questi giorni.
      renewWithinDays: int(process.env.SESSION_RENEW_DAYS, 7),
    },

    db: {
      configured: hasDiscretePg || hasPgUrl,
      useDiscrete: hasDiscretePg,
      connectionString: hasDiscretePg ? undefined : process.env.DATABASE_URL,
      maxClients: int(process.env.PG_POOL_MAX, 8),
      statementTimeoutMs: int(process.env.PG_STATEMENT_TIMEOUT_MS, 15000),
    },

    market: {
      provider: process.env.MARKET_PROVIDER || "yahoo",
      fxBase: "EUR",
      fxUrl: process.env.FX_API_URL || "https://api.frankfurter.dev/v2/rates",
      // Ampiezza del backfill quando non esistono transazioni da cui partire.
      backfillYears: int(process.env.BACKFILL_YEARS, 2),
    },

    scheduler: {
      enabled: bool(process.env.SCHEDULER_ENABLED, true),
      timezone: process.env.SCHEDULER_TZ || "Europe/Rome",
    },

    limits: {
      loginAttempts: int(process.env.LOGIN_ATTEMPTS, 10),
      loginWindowMs: int(process.env.LOGIN_WINDOW_MS, 15 * 60 * 1000),
      globalPerMinute: int(process.env.GLOBAL_RATE_LIMIT, 300),
    },
  };

  return config;
}

const config = build();

if (config.locked) {
  // Una volta, a livello error, così è visibile in Grafana e nella UI della
  // piattaforma. Poi si continua a servire.
  logger.error(
    { reasons: config.lockedReasons },
    "[config] LOCKED MODE: configurazione incompleta, /api/* risponderà 503 not_configured"
  );
}
if (!config.db.configured) {
  logger.warn("[config] nessun database configurato (PGHOST/DATABASE_URL assenti)");
}

// solo per i test

export { MIN_SECRET_LEN, build as _build };
export default config;
