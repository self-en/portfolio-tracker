// Unico formattatore dell'app. Locale it-IT, e nessun altro modulo costruisce un
// Intl.NumberFormat o un Intl.DateTimeFormat.
//
// Intl.NumberFormat accetta direttamente una stringa decimale e la formatta senza
// passare da un double (Intl.NumberFormat v3), quindi denaro e quantità restano
// stringhe fino al glifo: nemmeno qui compare un Number() su un importo. Le
// scritture di 17 cifre significative dei NUMERIC di Postgres sopravvivono.

export const DASH = "—";

const NBSP = " ";

const DECIMAL = /^[+-]?(\d+(\.\d*)?|\.\d+)$/;

const isBlank = (v) => v === null || v === undefined || v === "";

/**
 * Porta il valore in una forma che Intl accetta, senza aritmetica.
 * @returns {string|number|null} null se non è un decimale riconoscibile.
 */
function decimal(value) {
  if (isBlank(value)) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const s = String(value).trim();
  if (!DECIMAL.test(s)) return null;
  // Intl non digerisce il "+" iniziale.
  return s.startsWith("+") ? s.slice(1) : s;
}

const numberFormats = new Map();
function nf(key, options) {
  let f = numberFormats.get(key);
  if (!f) {
    f = new Intl.NumberFormat("it-IT", options);
    numberFormats.set(key, f);
  }
  return f;
}

const dateFormats = new Map();
function dtf(key, options) {
  let f = dateFormats.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat("it-IT", options);
    dateFormats.set(key, f);
  }
  return f;
}

/** Importo monetario. L'input è la stringa che arriva dall'API. */
export function money(value, ccy = "EUR") {
  const d = decimal(value);
  if (d === null) return DASH;
  return nf(`money:${ccy}`, { style: "currency", currency: ccy }).format(d);
}

/** Numero generico con `dp` decimali fissi. */
export function num(value, dp = 2) {
  const d = decimal(value);
  if (d === null) return DASH;
  return nf(`num:${dp}`, { minimumFractionDigits: dp, maximumFractionDigits: dp }).format(d);
}

/**
 * Sposta la virgola di due posizioni a destra operando sulla stringa.
 * Un `* 100` su un double introdurrebbe l'errore di rappresentazione proprio nel
 * punto in cui stiamo mostrando una percentuale al centesimo.
 */
function shiftTwo(s) {
  const neg = s.startsWith("-");
  const body = neg ? s.slice(1) : s;
  const [intPart, fracPart = ""] = body.split(".");
  const frac = fracPart.padEnd(2, "0");
  const shifted = (intPart + frac.slice(0, 2)).replace(/^0+(?=\d)/, "");
  const rest = frac.slice(2).replace(/0+$/, "");
  return (neg ? "-" : "") + (rest ? `${shifted}.${rest}` : shifted);
}

/** Percentuale. L'input è una FRAZIONE: "0.1706" → "17,06 %". */
export function pct(value, dp = 2) {
  const d = decimal(value);
  if (d === null) return DASH;
  const scaled = typeof d === "number" ? d * 100 : shiftTwo(d);
  return `${num(scaled, dp)}${NBSP}%`;
}

/** Quantità: fino a 8 decimali (quote frazionarie), senza zeri di coda. */
export function qty(value) {
  const d = decimal(value);
  if (d === null) return DASH;
  return nf("qty", { minimumFractionDigits: 0, maximumFractionDigits: 8 }).format(d);
}

/**
 * "2026-09-30" → "30/09/2026".
 * Per split della stringa e non via `new Date()`: la data è civile, e un Date
 * costruito da "YYYY-MM-DD" nasce a mezzanotte UTC — reso in un fuso a ovest di
 * Greenwich mostrerebbe il giorno prima.
 */
export function date(value) {
  if (isBlank(value)) return DASH;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : DASH;
}

/** "2026-09" → "set 2026". */
export function monthLabel(value) {
  if (isBlank(value)) return DASH;
  const m = /^(\d{4})-(\d{2})/.exec(String(value));
  if (!m) return DASH;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1));
  return dtf("month", { month: "short", year: "numeric", timeZone: "UTC" }).format(d);
}

/**
 * Ora locale di un istante ISO (es. l'ultimo refresh prezzi) → "14:35".
 * Qui il Date è corretto: il valore È un istante, non una data civile.
 */
export function time(value) {
  if (isBlank(value)) return DASH;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return DASH;
  return dtf("time", { hour: "2-digit", minute: "2-digit" }).format(d);
}

/** Istante ISO completo → "30/09/2026, 14:35". */
export function dateTime(value) {
  if (isBlank(value)) return DASH;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return DASH;
  return dtf("datetime", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

/** Delta con segno sempre esplicito (lo zero resta senza segno). */
export function signed(value, dp = 2) {
  const d = decimal(value);
  if (d === null) return DASH;
  return nf(`signed:${dp}`, {
    signDisplay: "exceptZero",
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  }).format(d);
}

/** Delta monetario con segno sempre esplicito. */
export function signedMoney(value, ccy = "EUR") {
  const d = decimal(value);
  if (d === null) return DASH;
  return nf(`signedMoney:${ccy}`, {
    style: "currency",
    currency: ccy,
    signDisplay: "exceptZero",
  }).format(d);
}

/** Delta percentuale con segno esplicito. L'input è una frazione. */
export function signedPct(value, dp = 2) {
  const d = decimal(value);
  if (d === null) return DASH;
  const scaled = typeof d === "number" ? d * 100 : shiftTwo(d);
  return `${signed(scaled, dp)}${NBSP}%`;
}

/**
 * Direzione di un valore, per scegliere una classe CSS senza convertirlo:
 * -1, 0, 1, oppure null se non è un decimale.
 */
export function signOf(value) {
  const d = decimal(value);
  if (d === null) return null;
  if (typeof d === "number") return Math.sign(d);
  if (d.startsWith("-")) return /[1-9]/.test(d) ? -1 : 0;
  return /[1-9]/.test(d) ? 1 : 0;
}

/** Classe CSS per i valori con segno: usa signOf, non un confronto numerico. */
export function toneOf(value) {
  const s = signOf(value);
  if (s === null) return "";
  if (s > 0) return "tone-up";
  if (s < 0) return "tone-down";
  return "tone-flat";
}
