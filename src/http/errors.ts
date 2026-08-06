// Forma unica degli errori API: { error: { code, message, details? } }.
// Un solo posto che decide lo status code per ciascun codice.
import type { FastifyReply, FastifyRequest } from "fastify";
import logger from "../logger";
import { errCode, errMessage, errStack } from "../util/err";

const STATUS = {
  unauthorized: 401,
  not_found: 404,
  validation_error: 422,
  conflict: 409,
  db_unavailable: 503,
  not_configured: 503,
  // Distinto da `not_configured`, che nella SPA significa "l'APP non è
  // configurata" e apre la schermata di configurazione: qui l'app funziona, è la
  // sola analisi con Claude a non essere disponibile.
  ai_unavailable: 503,
  upstream_error: 502,
  rate_limited: 429,
  internal_error: 500,
} as const;

export type ErrorCode = keyof typeof STATUS;

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = STATUS[code] || 500;
    this.details = details;
  }
}

const err = (code: ErrorCode, message: string, details?: unknown): ApiError =>
  new ApiError(code, message, details);

// Il messaggio arriva già concordato: l'italiano ha il genere, e comporre
// `${what} non trovata` produce "strumento non trovata".
const notFound = (message = "risorsa non trovata"): ApiError => err("not_found", message);
const conflict = (message: string, details?: unknown): ApiError => err("conflict", message, details);
const validation = (message: string, details?: unknown): ApiError => err("validation_error", message, details);
const unauthorized = (message = "autenticazione richiesta"): ApiError => err("unauthorized", message);

function send(reply: FastifyReply, code: ErrorCode, message: string, details?: unknown): FastifyReply {
  const status = STATUS[code] || 500;
  const body: ApiErrorBody = { error: { code, message } };
  if (details !== undefined) body.error.details = details;
  return reply.code(status).send(body);
}

/**
 * Gestore finale degli errori, registrato con setErrorHandler.
 *
 * In Express era un middleware ad arità 4 montato per ultimo, e l'arità era ciò
 * che lo faceva riconoscere; in Fastify è un hook esplicito. Sparisce anche la
 * ragione per cui esisteva asyncHandler(): qui un throw dentro un handler async
 * arriva sempre qui, senza doverlo inoltrare a mano con next(err).
 */
function errorHandler(e: unknown, request: FastifyRequest, reply: FastifyReply): FastifyReply | void {
  if (reply.sent) return;
  const path = request.url;

  if (e instanceof ApiError || (e as { name?: string })?.name === "ApiError") {
    const apiErr = e as ApiError;
    // Gli errori attesi sono rumore a livello info, non error.
    logger.info(
      { code: apiErr.code, path, details: apiErr.details },
      `[api] ${apiErr.code}: ${apiErr.message}`
    );
    return send(reply, apiErr.code, apiErr.message, apiErr.details);
  }

  // Il body malformato lo intercetta Fastify prima di noi (FST_ERR_CTP_*): senza
  // questo ramo diventerebbe un 500 "errore interno" invece di dire cosa non va.
  const fastifyCode = errCode(e);
  if (typeof fastifyCode === "string" && fastifyCode.startsWith("FST_ERR_CTP")) {
    return send(reply, "validation_error", "corpo della richiesta non valido");
  }

  // Violazioni di constraint Postgres tradotte in errori parlanti invece di 500.
  const pg = e as { code?: string; constraint?: string; column?: string };
  if (pg?.code === "23505") {
    return send(reply, "conflict", "vincolo di unicità violato", { constraint: pg.constraint });
  }
  if (pg?.code === "23514") {
    return send(reply, "validation_error", "vincolo di validità violato dal database", {
      constraint: pg.constraint,
    });
  }
  if (pg?.code === "23503") {
    return send(reply, "conflict", "riferimento a una riga inesistente o ancora referenziata", {
      constraint: pg.constraint,
    });
  }
  if (pg?.code === "23502") {
    return send(reply, "validation_error", "campo obbligatorio mancante", { column: pg.column });
  }

  logger.error({ err: errMessage(e), stack: errStack(e), path }, "[api] errore non gestito");
  return send(reply, "internal_error", "errore interno");
}

export { ApiError, STATUS, err, notFound, conflict, validation, unauthorized, send, errorHandler };
