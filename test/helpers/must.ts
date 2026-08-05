import assert from "node:assert/strict";

/**
 * Il valore, garantito non nullo, o un fallimento del test con un messaggio che
 * dice COSA mancava.
 *
 * Serve perché i mapper di src/repo/rows.ts sono condivisi tra le letture per id
 * (dove la riga può non esserci) e le INSERT ... RETURNING (dove c'è per
 * costruzione), quindi anche `create()` è tipizzata `T | null`. Il codice di
 * produzione lo risolve con `!`; nei test `!` sarebbe peggio: un null diventerebbe
 * un "cannot read properties of null" su una riga qualsiasi più in basso, invece
 * di dire che la INSERT non ha restituito niente.
 */
export function must<T>(value: T | null | undefined, what = "il valore"): T {
  assert.ok(value !== null && value !== undefined, `${what} non dovrebbe essere null`);
  return value;
}
