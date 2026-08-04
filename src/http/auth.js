// Autenticazione a password singola con cookie di sessione firmato, stateless.
//
// Scartati express-session (serve uno store → dipendenza, tabella e sweeper) e
// iron-session (orientato a Next). Per un utente singolo un cookie firmato è
// esattamente giusto: `cookie-parser` + `node:crypto`, nulla di più.
//
// Il modulo è scritto per essere testabile senza HTTP: sign/verify sono funzioni
// pure che prendono il segreto e il tempo come parametri.
const crypto = require("node:crypto");
const config = require("../config");
const logger = require("../logger");
const { send } = require("./errors");

const DAY_MS = 24 * 60 * 60 * 1000;

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const unb64u = (s) => Buffer.from(s, "base64url");

function hmac(payloadB64, secret) {
  return crypto.createHmac("sha256", secret).update(payloadB64).digest();
}

/** Confronto a tempo costante che non lancia su lunghezze diverse. */
function safeEqual(a, b) {
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
function verifyPassword(candidate, { appPassword, sessionSecret }) {
  if (!appPassword || !sessionSecret) return false;
  const derive = (s) => crypto.scryptSync(String(s), sessionSecret, 32);
  return safeEqual(derive(candidate), derive(appPassword));
}

/**
 * Firma un token di sessione.
 * @returns {{token: string, expiresAt: string, sid: string}}
 */
function signToken({ secret, now = Date.now(), ttlDays = 30, sid = crypto.randomUUID() }) {
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
function verifyToken(token, { secret, now = Date.now() }) {
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

  let payload;
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

function cookieOptions({ maxAgeMs }) {
  return {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    // Secure solo su richiesta esplicita: gli env di branch sono http:// e un
    // cookie Secure viene scartato in silenzio (login 204, poi 401 su tutto).
    secure: config.auth.cookieSecure,
    maxAge: maxAgeMs,
  };
}

function setSessionCookie(res, token, ttlDays = config.auth.sessionTtlDays) {
  res.cookie(config.auth.cookieName, token, cookieOptions({ maxAgeMs: ttlDays * DAY_MS }));
}

function clearSessionCookie(res) {
  res.clearCookie(config.auth.cookieName, { ...cookieOptions({ maxAgeMs: 0 }), maxAge: undefined });
}

/**
 * Middleware: richiede una sessione valida. Rinnovo scorrevole quando restano
 * meno di `renewWithinDays` giorni, così un uso quotidiano non incontra mai una
 * scadenza.
 */
function requireAuth(req, res, next) {
  const token = req.cookies?.[config.auth.cookieName];
  const result = verifyToken(token, { secret: config.auth.sessionSecret });

  if (!result.ok) {
    if (result.reason !== "missing") {
      logger.info({ reason: result.reason, path: req.originalUrl }, "[auth] sessione rifiutata");
    }
    return send(res, "unauthorized", "autenticazione richiesta");
  }

  req.session = result.payload;

  const msLeft = result.payload.exp * 1000 - Date.now();
  if (msLeft < config.auth.renewWithinDays * DAY_MS) {
    const fresh = signToken({
      secret: config.auth.sessionSecret,
      ttlDays: config.auth.sessionTtlDays,
      sid: result.payload.sid,
    });
    setSessionCookie(res, fresh.token);
    req.session.exp = fresh.exp;
  }

  return next();
}

module.exports = {
  verifyPassword,
  signToken,
  verifyToken,
  requireAuth,
  setSessionCookie,
  clearSessionCookie,
  safeEqual,
};
