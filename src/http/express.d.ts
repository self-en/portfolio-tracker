// Estensione dei tipi di Express con i campi che i middleware di questa app
// attaccano alla richiesta.
//
// `req.valid` e' il risultato della validazione zod (src/http/validate.ts): i
// middleware `body()`/`query()`/`params()` ci mettono il valore PARSATO, e le
// route leggono solo da li' - mai da req.body/req.query grezzi. Tipizzarlo qui,
// una volta, e' quello che rende l'invariante visibile al compilatore in tutte le
// route invece di ripeterla in un commento.
//
// I valori sono `any` di proposito: lo schema zod cambia per route, quindi il
// tipo preciso e' quello che la route stessa si aspetta. L'alternativa (generici
// su ogni handler) costerebbe molto piu' di quanto renda.
import "express";

declare global {
  namespace Express {
    interface Request {
      valid?: {
        body?: any;
        query?: any;
        params?: any;
      };
    }
  }
}
