// Forma unica degli errori API: { error: { code, message, details? } }.
// Un solo posto che decide lo status code per ciascun codice.
import logger from "../logger";
import type { NextFunction, Request, Response } from "express";

const STATUS = {
  unauthorized: 401,
  not_found: 404,
  validation_error: 422,
  conflict: 409,
  db_unavailable: 503,
  not_configured: 503,
  upstream_error: 502,
  rate_limited: 429,
  internal_error: 500,
};

class ApiError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = STATUS[code] || 500;
    this.details = details;
  }
}

const err = (code, message, details) => new ApiError(code, message, details);

// Il messaggio arriva già concordato: l'italiano ha il genere, e comporre
// `${what} non trovata` produce "strumento non trovata".
const notFound = (message = "risorsa non trovata") => err("not_found", message);
const conflict = (message, details) => err("conflict", message, details);
const validation = (message, details) => err("validation_error", message, details);
const unauthorized = (message = "autenticazione richiesta") => err("unauthorized", message);

function send(res, code, message, details) {
  const status = STATUS[code] || 500;
  const body = { error: { code, message } };
  if (details !== undefined) body.error.details = details;
  return res.status(status).json(body);
}

/** Middleware finale di gestione errori. Va montato per ultimo. */
// eslint-disable-next-line no-unused-vars -- express riconosce gli error handler dall'arità 4
function errorHandler(e, req, res, _next) {
  if (res.headersSent) return;

  if (e instanceof ApiError || e?.name === "ApiError") {
    // Gli errori attesi sono rumore a livello info, non error.
    logger.info(
      { code: e.code, path: req.originalUrl, details: e.details },
      `[api] ${e.code}: ${e.message}`
    );
    return send(res, e.code, e.message, e.details);
  }

  // Violazioni di constraint Postgres tradotte in errori parlanti invece di 500.
  if (e?.code === "23505") {
    return send(res, "conflict", "vincolo di unicità violato", { constraint: e.constraint });
  }
  if (e?.code === "23514") {
    return send(res, "validation_error", "vincolo di validità violato dal database", {
      constraint: e.constraint,
    });
  }
  if (e?.code === "23503") {
    return send(res, "conflict", "riferimento a una riga inesistente o ancora referenziata", {
      constraint: e.constraint,
    });
  }
  if (e?.code === "23502") {
    return send(res, "validation_error", "campo obbligatorio mancante", { column: e.column });
  }

  logger.error(
    { err: e?.message, stack: e?.stack, path: req.originalUrl },
    "[api] errore non gestito"
  );
  return send(res, "internal_error", "errore interno");
}

/** Avvolge un handler async così un reject finisce nell'error handler di express 4. */
const asyncHandler = (fn) => (req: Request, res: Response, next: NextFunction) => Promise.resolve(fn(req, res, next)).catch(next);

export { ApiError, STATUS, err, notFound, conflict, validation, unauthorized, send, errorHandler, asyncHandler };
