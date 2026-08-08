// IL CONFINE FLOAT dell'applicazione (docs/decisions.md §1).
//
// Qui — e solo qui, dentro web/src/charts/ — le stringhe decimali che arrivano
// dall'API diventano numeri, perché un pixel è un float e un SVG non sa fare
// aritmetica decimale. Ogni altro modulo tratta gli importi come stringhe e li
// passa a web/src/format.js.
//
// I valori convertiti servono SOLO a posizionare le marche. Tutto ciò che
// l'utente legge (assi esclusi, che sono etichette di scala) viene formattato
// dalla stringa originale, mai dal float.

/** Ciò che entra in questo confine: un importo dall'API, o un numero già tale. */
export type Convertible = string | number | null | undefined;

/**
 * Stringa decimale → numero, oppure null.
 *
 * null e non 0: uno zero silenzioso al posto di un dato mancante somiglia a un
 * crollo del portafoglio, ed è la peggior modalità di fallimento dell'app (§5).
 * recharts interrompe la linea sui null, che è esattamente ciò che serve.
 */
export function toNumber(value: Convertible): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Come toNumber ma con 0 al posto di null: per le altezze delle colonne in stack. */
export function toNumberOrZero(value: Convertible): number {
  const n = toNumber(value);
  return n === null ? 0 : n;
}

/** true se il valore decimale è diverso da zero (senza passare da un confronto su stringa). */
export function isPositive(value: Convertible): boolean {
  const n = toNumber(value);
  return n !== null && n > 0;
}

/** Estremi di una lista di numeri, ignorando i null. */
export function extent(values: Array<number | null>): { min: number | null; max: number | null } {
  let min: number | null = null;
  let max: number | null = null;
  for (const v of values) {
    if (v === null) continue;
    if (min === null || v < min) min = v;
    if (max === null || v > max) max = v;
  }
  return { min, max };
}

// Tick dell'asse y in forma COMPATTA ("1,2 Mln"), per i plot stretti.
//
// Su telefono l'asse y scende a 40px: `num(v, 0)` su un valore come 1.234.567
// misura più del doppio e recharts lo taglia a metà, che è peggio di non
// mostrarlo. A larghezza piena i tick restano quelli per esteso.
const COMPACT = new Intl.NumberFormat("it-IT", {
  notation: "compact",
  maximumFractionDigits: 1,
});

export function compactTick(value: Convertible): string {
  const n = toNumber(value);
  return n === null ? "" : COMPACT.format(n);
}

/** Clamp, per non far uscire un raggio d'angolo dalla sua colonna. */
export function clamp(value: number, lo: number, hi: number): number {
  return value < lo ? lo : value > hi ? hi : value;
}
