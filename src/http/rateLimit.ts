// Rate limiter in memoria a finestra fissa. Nessuna dipendenza.
//
// `replicaCount` è 1, quindi lo stato in memoria è una scelta onesta e non una
// scorciatoia: un limiter distribuito richiederebbe Redis per proteggere un'app a
// utente singolo. Se un giorno le repliche diventano 2+, questo diventa "10
// tentativi per replica" — accettabile per il brute force, da rifare se serve
// precisione.
import { send } from "./errors";
import logger from "../logger";

function createLimiter({ windowMs, max, name }) {
  /** @type {Map<string, {count: number, resetAt: number}>} */
  const buckets = new Map();

  // Sweep periodico: senza, la Map cresce con ogni IP visto, per sempre.
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [key, b] of buckets) if (b.resetAt <= now) buckets.delete(key);
  }, windowMs);
  // unref: questo timer non deve tenere vivo il processo né bloccare i test.
  if (typeof sweeper.unref === "function") sweeper.unref();

  function hit(key) {
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || b.resetAt <= now) {
      b = { count: 0, resetAt: now + windowMs };
      buckets.set(key, b);
    }
    b.count += 1;
    return { allowed: b.count <= max, retryAfterSec: Math.ceil((b.resetAt - now) / 1000), count: b.count };
  }

  function middleware(req, res, next) {
    // Dietro il Gateway l'IP reale sta in X-Forwarded-For. Prendiamo il primo hop.
    const fwd = req.headers["x-forwarded-for"];
    const ip = (typeof fwd === "string" ? fwd.split(",")[0].trim() : "") || req.ip || "unknown";
    const r = hit(ip);
    if (!r.allowed) {
      logger.warn({ limiter: name, ip, count: r.count }, "[ratelimit] richiesta bloccata");
      res.set("Retry-After", String(r.retryAfterSec));
      return send(res, "rate_limited", "troppe richieste, riprova più tardi", {
        retryAfterSec: r.retryAfterSec,
      });
    }
    return next();
  }

  return { middleware, hit, _buckets: buckets, _sweeper: sweeper };
}

export { createLimiter };
