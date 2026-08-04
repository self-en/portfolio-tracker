const express = require("express");
const config = require("../../config");
const logger = require("../../logger");
const { z, body, parse } = require("../validate");
const { asyncHandler, unauthorized } = require("../errors");
const {
  verifyPassword,
  signToken,
  verifyToken,
  setSessionCookie,
  clearSessionCookie,
} = require("../auth");
const { createLimiter } = require("../rateLimit");

const router = express.Router();

// 10 tentativi / 15 minuti per IP. Ogni fallimento è loggato a warn con l'IP.
const loginLimiter = createLimiter({
  windowMs: config.limits.loginWindowMs,
  max: config.limits.loginAttempts,
  name: "login",
});

const loginSchema = z.object({ password: z.string().min(1, "password obbligatoria") });

router.post(
  "/login",
  loginLimiter.middleware,
  body(loginSchema),
  asyncHandler(async (req, res) => {
    const { password } = req.valid.body;

    if (!verifyPassword(password, config.auth)) {
      const fwd = req.headers["x-forwarded-for"];
      const ip = (typeof fwd === "string" ? fwd.split(",")[0].trim() : "") || req.ip;
      // Loggare il tentativo, MAI la password (il logger la redige comunque).
      logger.warn({ ip }, "[auth] tentativo di login fallito");
      throw unauthorized("password non corretta");
    }

    const { token } = signToken({
      secret: config.auth.sessionSecret,
      ttlDays: config.auth.sessionTtlDays,
    });
    setSessionCookie(res, token);
    logger.info("[auth] login riuscito");
    return res.status(204).end();
  })
);

router.post("/logout", (_req, res) => {
  clearSessionCookie(res);
  return res.status(204).end();
});

// Non autenticata di proposito: è il modo in cui la SPA scopre se ha una sessione
// senza incassare un 401 e finire nel redirect globale a /login.
router.get("/me", (req, res) => {
  const token = req.cookies?.[config.auth.cookieName];
  const result = verifyToken(token, { secret: config.auth.sessionSecret });
  if (!result.ok) {
    return res.json({ authenticated: false, reason: result.reason });
  }
  return res.json({
    authenticated: true,
    expiresAt: new Date(result.payload.exp * 1000).toISOString(),
  });
});

module.exports = { router, loginSchema, parse };
