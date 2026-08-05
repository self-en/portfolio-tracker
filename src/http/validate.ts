// Validazione con zod, più gli scalari condivisi da tutto il layer HTTP.
//
// Nota di progetto: denaro e quantità arrivano e partono come STRINGHE
// (docs/decisions.md §1). Gli schemi qui accettano stringhe decimali e le
// validano con una regex, senza mai passare da parseFloat: convertire in Number
// per validare e poi ri-stringificare è esattamente il modo in cui l'errore
// float entra in un sistema decimale.
import { z } from "zod";
import { validation } from "./errors";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { ZodType } from "zod";

const DECIMAL_RE = /^-?\d{1,20}(\.\d{1,12})?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CCY_RE = /^[A-Z]{3}$/;

/** Stringa decimale. Accetta anche un number in input (lo stringifica) per tolleranza verso i client. */
const decimalString = (opts: { positive?: boolean; nonNegative?: boolean } = {}) => {
  let s = z
    .union([z.string(), z.number()])
    .transform((v) => (typeof v === "number" ? String(v) : v.trim()))
    .refine((v) => DECIMAL_RE.test(v), { message: "non è un numero decimale valido" });
  if (opts.positive) s = s.refine((v) => Number(v) > 0, { message: "deve essere maggiore di zero" });
  if (opts.nonNegative) s = s.refine((v) => Number(v) >= 0, { message: "non può essere negativo" });
  return s;
};

/** Data ISO 'YYYY-MM-DD'. Verifica anche che il giorno esista davvero (no 2026-02-30). */
const dateString = () =>
  z
    .string()
    .regex(DATE_RE, "la data deve essere in formato YYYY-MM-DD")
    .refine((v) => {
      const [y, m, d] = v.split("-").map(Number) as [number, number, number];
      const dt = new Date(Date.UTC(y, m - 1, d));
      return (
        dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
      );
    }, "data inesistente nel calendario");

const currency = () =>
  z
    .string()
    .transform((v) => v.trim().toUpperCase())
    .refine((v) => CCY_RE.test(v), "la valuta deve essere un codice ISO di 3 lettere");

const idParam = () => z.coerce.number().int().positive();

/**
 * Valida `data` con `schema`, oppure lancia un ApiError validation_error che
 * porta l'elenco dei campi in `details`.
 */
function parse<T>(schema: ZodType<T>, data: unknown, what = "richiesta"): T {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  const details = result.error.issues.map((i) => ({
    field: i.path.join(".") || "(root)",
    message: i.message,
    code: i.code,
  }));
  throw validation(`${what} non valida`, details);
}

/** Helper per i middleware: valida body / query / params e sostituisce il valore parsato. */
const body =
  <T,>(schema: ZodType<T>) =>
  async (req: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    req.valid = { ...(req.valid || {}), body: parse(schema, req.body, "body") };
  };

const query =
  <T,>(schema: ZodType<T>) =>
  async (req: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    req.valid = { ...(req.valid || {}), query: parse(schema, req.query, "query string") };
  };

const params =
  <T,>(schema: ZodType<T>) =>
  async (req: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    req.valid = { ...(req.valid || {}), params: parse(schema, req.params, "parametri di percorso") };
  };

export { z, parse, body, query, params, decimalString, dateString, currency, idParam, DECIMAL_RE, DATE_RE };
