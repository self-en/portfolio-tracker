// Estensione dei tipi di Fastify con i campi che i preHandler di questa app
// attaccano alla richiesta.
//
// `req.valid` e' il risultato della validazione zod (src/http/validate.ts): i
// preHandler `body()`/`query()`/`params()` ci mettono il valore PARSATO, e gli
// handler leggono solo da li' - mai da req.body/req.query grezzi. Dichiararlo qui,
// una volta, rende l'invariante visibile al compilatore in tutte le route invece
// di ripeterla in un commento.
//
// I valori sono `any` di proposito: lo schema zod cambia per route, quindi il tipo
// preciso e' quello che la route stessa si aspetta. L'alternativa (un generico su
// ogni handler) costerebbe piu' di quanto renda.
import "fastify";
// Porta con se' l'augmentation di @fastify/cookie (reply.setCookie /
// req.cookies): senza questo import i tipi del plugin non entrano in gioco e il
// compilatore non vede quei metodi.
import "@fastify/cookie";

declare module "fastify" {
  interface FastifyRequest {
    valid?: {
      body?: any;
      query?: any;
      params?: any;
    };
    /** Il payload del cookie di sessione, messo da requireAuth. */
    session?: import("./auth").SessionPayload;
  }
}
