// Rate limiter in memoria a finestra fissa. Nessuna dipendenza.
//
// `replicaCount` è 1, quindi lo stato in memoria è una scelta onesta e non una
// scorciatoia: un limiter distribuito richiederebbe Redis per proteggere un'app a
// utente singolo. Se un giorno le repliche diventano 2+, questo diventa "10
// tentativi per replica" — accettabile per il brute force, da rifare se serve
// precisione.
import type { FastifyReply, FastifyRequest } from "fastify";
import { send } from "./errors";
import logger from "../logger";

export interface LimiterOptions {
  windowMs: number;
  max: number;
  name: string;
}

interface Bucket {
  count: number;
  resetAt: number;
}

function createLimiter({ windowMs, max, name }: LimiterOptions) {
  const buckets = new Map<string, Bucket>();

  // Sweep periodico: senza, la Map cresce con ogni IP visto, per sempre.
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [key, b] of buckets) if (b.resetAt <= now) buckets.delete(key);
  }, windowMs);
  // unref: questo timer non deve tenere vivo il processo né bloccare i test.
  if (typeof sweeper.unref === "function") sweeper.unref();

  function hit(key: string) {
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || b.resetAt <= now) {
      b = { count: 0, resetAt: now + windowMs };
      buckets.set(key, b);
    }
    b.count += 1;
    return { allowed: b.count <= max, retryAfterSec: Math.ceil((b.resetAt - now) / 1000), count: b.count };
  }

  /**
   * Hook Fastify (onRequest / preHandler). In Express era un middleware con
   * `next()`; qui basta NON restituire nulla per proseguire, e restituire la
   * reply per fermare la catena.
   */
  async function hook(req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | void> {
    // Dietro il Gateway l'IP reale sta in X-Forwarded-For. Con trustProxy attivo
    // e' gia' `req.ip` a portarlo; l'header resta come rete di sicurezza.
    const fwd = req.headers["x-forwarded-for"];
    const ip = req.ip || (typeof fwd === "string" ? fwd.split(",")[0].trim() : "") || "unknown";
    const r = hit(ip);
    if (!r.allowed) {
      logger.warn({ limiter: name, ip, count: r.count }, "[ratelimit] richiesta bloccata");
      void reply.header("Retry-After", String(r.retryAfterSec));
      return send(reply, "rate_limited", "troppe richieste, riprova più tardi", {
        retryAfterSec: r.retryAfterSec,
      });
    }
  }

  return { hook, hit, _buckets: buckets, _sweeper: sweeper };
}

export { createLimiter };
