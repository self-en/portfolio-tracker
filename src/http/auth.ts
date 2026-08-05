// Autenticazione a password singola con cookie di sessione firmato, stateless.
//
// Scartati express-session (serve uno store → dipendenza, tabella e sweeper) e
// iron-session (orientato a Next). Per un utente singolo un cookie firmato è
// esattamente giusto: `@fastify/cookie` + `node:crypto`, nulla di più.
//
// Il modulo è scritto per essere testabile senza HTTP: sign/verify sono funzioni
// pure che prendono il segreto e il tempo come parametri.
import crypto from "node:crypto";
import config from "../config";
import logger from "../logger";
import { send } from "./errors";
import type { FastifyReply, FastifyRequest } from "fastify";

/** Il payload dentro il cookie di sessione. */
export interface SessionPayload {
  v: number;
  iat: number;
  exp: number;
  sid: string;
}

export type VerifyResult = { ok: true; payload: SessionPayload } | { ok: false; reason: string };

const DAY_MS = 24 * 60 * 60 * 1000;

const b64u = (buf: Buffer | string): string => Buffer.from(buf).toString("base64url");
const unb64u = (s: string): Buffer => Buffer.from(s, "base64url");

function hmac(payloadB64: string, secret: string): Buffer {
  return crypto.createHmac("sha256", secret).update(payloadB64).digest();
}

/** Confronto a tempo costante che non lancia su lunghezze diverse. */
function safeEqual(a: Buffer | string, b: Buffer | string): boolean {
  const ab = Buffer.isBuffer(a) ? a : Buffer.from(String(a));
  const bb = Buffer.isBuffer(b) ? b : Buffer.from(String(b));
  if (ab.length !== bb.length) {
    // timingSafeEqual lancia su lunghezze diverse; confrontiamo comunque contro
    // qualcosa della lunghezza giusta per non aprire un oracolo sulla lunghezza.
    crypto.timingSafeEqual(ab, ab);
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * Verifica la password. scrypt con il session secret come salt, confronto a
 * tempo costante. Il salt fisso va bene qui: c'è UNA password e il segreto non
 * è nel database, quindi non esiste lo scenario "rainbow table su un dump".
 */
function verifyPassword(
  candidate: string,
  { appPassword, sessionSecret }: { appPassword: string; sessionSecret: string }
): boolean {
  if (!appPassword || !sessionSecret) return false;
  const derive = (s: string): Buffer => crypto.scryptSync(String(s), sessionSecret, 32);
  return safeEqual(derive(candidate), derive(appPassword));
}

/**
 * Firma un token di sessione.
 * @returns {{token: string, expiresAt: string, sid: string}}
 */
function signToken({
  secret,
  now = Date.now(),
  ttlDays = 30,
  sid = crypto.randomUUID(),
}: {
  secret: string;
  now?: number;
  ttlDays?: number;
  sid?: string;
}) {
  const iat = Math.floor(now / 1000);
  const exp = iat + ttlDays * 86400;
  const payload = b64u(JSON.stringify({ v: 1, iat, exp, sid }));
  const sig = b64u(hmac(payload, secret));
  return {
    token: `${payload}.${sig}`,
    expiresAt: new Date(exp * 1000).toISOString(),
    sid,
    exp,
  };
}

/**
 * Verifica un token. Restituisce il payload, oppure null con la ragione.
 * @returns {{ok: true, payload: object} | {ok: false, reason: string}}
 */
function verifyToken(
  token: string | undefined,
  { secret, now = Date.now() }: { secret: string; now?: number }
): VerifyResult {
  if (!token || typeof token !== "string") return { ok: false, reason: "missing" };
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return { ok: false, reason: "malformed" };

  const payloadB64 = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);

  // Firma PRIMA di fidarsi del contenuto: mai fare JSON.parse su dati non
  // autenticati e poi decidere.
  if (!safeEqual(unb64u(sigB64), hmac(payloadB64, secret))) {
    return { ok: false, reason: "bad_signature" };
  }

  let payload: SessionPayload;
  try {
    payload = JSON.parse(unb64u(payloadB64).toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (payload?.v !== 1) return { ok: false, reason: "bad_version" };
  if (typeof payload.exp !== "number") return { ok: false, reason: "malformed" };
  if (payload.exp * 1000 <= now) return { ok: false, reason: "expired" };

  return { ok: true, payload };
}

function cookieOptions({ maxAgeMs }: { maxAgeMs: number }) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    path: "/",
    // Secure solo su richiesta esplicita: gli env di branch sono http:// e un
    // cookie Secure viene scartato in silenzio (login 204, poi 401 su tutto).
    secure: config.auth.cookieSecure,
    // @fastify/cookie vuole i SECONDI, express i millisecondi: e' il tipo di
    // dettaglio che in un port si sbaglia una volta sola e poi si scopre da un
    // cookie che scade dopo 30 secondi invece di 30 giorni.
    maxAge: Math.floor(maxAgeMs / 1000),
  };
}

function setSessionCookie(reply: FastifyReply, token: string, ttlDays = config.auth.sessionTtlDays): void {
  void reply.setCookie(config.auth.cookieName, token, cookieOptions({ maxAgeMs: ttlDays * DAY_MS }));
}

function clearSessionCookie(reply: FastifyReply): void {
  void reply.clearCookie(config.auth.cookieName, { ...cookieOptions({ maxAgeMs: 0 }), maxAge: undefined });
}

/**
 * Hook: richiede una sessione valida. Rinnovo scorrevole quando restano meno di
 * `renewWithinDays` giorni, così un uso quotidiano non incontra mai una scadenza.
 *
 * Restituire la reply ferma la catena; non restituire niente la fa proseguire
 * (in Express era `next()`).
 */
async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | void> {
  const token = req.cookies?.[config.auth.cookieName];
  const result = verifyToken(token, { secret: config.auth.sessionSecret });

  if (!result.ok) {
    if (result.reason !== "missing") {
      logger.info({ reason: result.reason, path: req.url }, "[auth] sessione rifiutata");
    }
    return send(reply, "unauthorized", "autenticazione richiesta");
  }

  req.session = result.payload;

  const msLeft = result.payload.exp * 1000 - Date.now();
  if (msLeft < config.auth.renewWithinDays * DAY_MS) {
    const fresh = signToken({
      secret: config.auth.sessionSecret,
      ttlDays: config.auth.sessionTtlDays,
      sid: result.payload.sid,
    });
    setSessionCookie(reply, fresh.token);
    req.session.exp = fresh.exp;
  }
}

export { verifyPassword, signToken, verifyToken, requireAuth, setSessionCookie, clearSessionCookie, safeEqual };
