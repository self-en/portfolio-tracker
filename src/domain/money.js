// Rappresentazione del denaro. L'UNICO posto dove si configura l'aritmetica.
//
// Questo file — e tutto src/domain/ — importa SOLO decimal.js: nessun pg, nessun
// logger, nessun Date.now(). È ciò che rende la matematica finanziaria testabile
// senza database, che in locale non c'è (docs/decisions.md §7).
const Decimal = require("decimal.js");

// precision 34: abbondante per catene di moltiplicazioni qty×prezzo×fx senza
// perdita percepibile. ROUND_HALF_EVEN (arrotondamento del banchiere) evita il
// bias verso l'alto di HALF_UP su migliaia di arrotondamenti.
// toExpNeg/toExpPos larghi: senza, toString() passerebbe a notazione
// esponenziale e finirebbe "1e-7" in una risposta JSON.
const D = Decimal.clone({
  precision: 34,
  rounding: Decimal.ROUND_HALF_EVEN,
  toExpNeg: -12,
  toExpPos: 30,
});

/** Decimali di persistenza, allineati alla scale delle colonne NUMERIC. */
const DP = { QTY: 8, PRICE: 8, MONEY: 6, FX: 10, RATE: 8, DISPLAY: 2 };

const ZERO = new D(0);
const ONE = new D(1);
const HUNDRED = new D(100);

/**
 * Converte in Decimal in modo tollerante. null/undefined/'' → default (0).
 * Accetta stringhe (il caso normale: è così che arrivano da pg e dall'API),
 * Decimal, e number (solo per comodità dei test — non passarne dal codice).
 */
function d(v, dflt = 0) {
  if (v === null || v === undefined || v === "") return new D(dflt);
  if (v instanceof D) return v;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return new D(dflt);
    return new D(String(v));
  }
  try {
    const x = new D(String(v).trim());
    return x.isNaN() ? new D(dflt) : x;
  } catch {
    return new D(dflt);
  }
}

/** true se il valore è assente o non interpretabile come numero. */
function isBlank(v) {
  if (v === null || v === undefined || v === "") return true;
  if (typeof v === "number") return !Number.isFinite(v);
  if (v instanceof D) return v.isNaN();
  try {
    return new D(String(v).trim()).isNaN();
  } catch {
    return true;
  }
}

/** Arrotonda a `dp` decimali e restituisce una STRINGA (il formato sul filo). */
function fixed(v, dp) {
  return d(v).toDecimalPlaces(dp, D.ROUND_HALF_EVEN).toFixed(dp);
}

const money = (v) => fixed(v, DP.MONEY);
const qty = (v) => fixed(v, DP.QTY);
const price = (v) => fixed(v, DP.PRICE);
const fx = (v) => fixed(v, DP.FX);
const rate = (v) => fixed(v, DP.RATE);

/** Somma una lista di valori. */
function sum(list) {
  let acc = ZERO;
  for (const v of list) acc = acc.plus(d(v));
  return acc;
}

/**
 * Converte un importo da `ccy` a EUR dato il tasso EUR→ccy.
 * DIVISIONE, non moltiplicazione: `rate` è "unità di ccy per 1 EUR"
 * (docs/decisions.md §2). Invertire questa riga è il bug FX classico.
 */
function toBase(amount, fxRate) {
  const r = d(fxRate, 1);
  if (r.isZero()) return ZERO; // difensivo: un tasso 0 non è convertibile
  return d(amount).div(r);
}

/** Converte da EUR a `ccy`: moltiplicazione. */
function fromBase(amount, fxRate) {
  return d(amount).times(d(fxRate, 1));
}

/**
 * Peso come frazione (non percentuale). Restituisce "0" se il totale è zero,
 * invece di NaN o Infinity.
 */
function share(part, total) {
  const t = d(total);
  if (t.isZero()) return ZERO;
  return d(part).div(t);
}

/** Divisione che restituisce null invece di Infinity/NaN quando il divisore è 0. */
function safeDiv(a, b) {
  const den = d(b);
  if (den.isZero()) return null;
  return d(a).div(den);
}

module.exports = {
  D,
  DP,
  ZERO,
  ONE,
  HUNDRED,
  d,
  isBlank,
  fixed,
  money,
  qty,
  price,
  fx,
  rate,
  sum,
  toBase,
  fromBase,
  share,
  safeDiv,
};
