import express from "express";
import config from "../../config";
import logger from "../../logger";
import { z, body, parse } from "../validate";
import { asyncHandler, unauthorized } from "../errors";
import {
  verifyPassword,
  signToken,
  verifyToken,
  setSessionCookie,
  clearSessionCookie,
} from "../auth";
import { createLimiter } from "../rateLimit";

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
  asyncHandler(async (req: Request, res: Response) => {
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

router.post("/logout", (_req: Request, res: Response) => {
  clearSessionCookie(res);
  return res.status(204).end();
});

// Non autenticata di proposito: è il modo in cui la SPA scopre se ha una sessione
// senza incassare un 401 e finire nel redirect globale a /login.
router.get("/me", (req: Request, res: Response) => {
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

export { router, loginSchema, parse };
