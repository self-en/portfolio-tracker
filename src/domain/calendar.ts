// Aritmetica sulle date, tutta su stringhe "YYYY-MM-DD" con Date.UTC.
//
// MAI un Date in fuso locale: così il DST si aggira invece di testarci intorno, e
// una data non può cambiare giorno solo perché il container gira in UTC e lo
// sviluppatore è a Roma (docs/decisions.md §6).
import type { DateString } from "../types";

const DAY_MS = 86_400_000;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function assertDate(s: unknown, label = "data"): void {
  if (typeof s !== "string" || !DATE_RE.test(s)) {
    throw new TypeError(`${label} deve essere una stringa 'YYYY-MM-DD', ricevuto ${JSON.stringify(s)}`);
  }
}

/** "YYYY-MM-DD" → millisecondi UTC di mezzanotte. */
function toMs(s: DateString): number {
  assertDate(s);
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  return Date.UTC(y, m - 1, d);
}

/** millisecondi → "YYYY-MM-DD". */
function toISO(ms: number): DateString {
  const dt = new Date(ms);
  const y = String(dt.getUTCFullYear()).padStart(4, "0");
  const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const d = String(dt.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Normalizza una data da varie sorgenti (Date, ISO datetime, stringa) a "YYYY-MM-DD". */
function normalizeDate(v: unknown): DateString | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "string") {
    if (DATE_RE.test(v)) return v;
    // 'YYYY-MM-DDTHH:mm:ssZ' → si prende la parte UTC della data. Le barre di
    // Yahoo arrivano così, come istante di apertura del mercato.
    const m = /^(\d{4}-\d{2}-\d{2})T/.exec(v);
    if (m) return m[1] as DateString;
    return null;
  }
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : toISO(v.getTime());
  if (typeof v === "number") return toISO(v);
  return null;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const min = (a: DateString, b: DateString): DateString => (cmp(a, b) <= 0 ? a : b);
const max = (a: DateString, b: DateString): DateString => (cmp(a, b) >= 0 ? a : b);

function addDays(s: DateString, n: number): DateString {
  return toISO(toMs(s) + n * DAY_MS);
}

/** Giorni di calendario tra due date (b - a). Esatto: entrambe sono mezzanotte UTC. */
function daysBetween(a: DateString, b: DateString): number {
  return Math.round((toMs(b) - toMs(a)) / DAY_MS);
}

/** Ultimo giorno del mese, 1-based. Gestisce gli anni bisestili via Date.UTC. */
function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

const isEom = (s: DateString): boolean => {
  assertDate(s);
  return Number(s.slice(8, 10)) === lastDayOfMonth(Number(s.slice(0, 4)), Number(s.slice(5, 7)));
};

/**
 * Aggiunge `n` mesi preservando la convenzione di fine mese.
 *
 * Se la data di partenza è l'ULTIMO giorno del suo mese, il risultato è l'ultimo
 * giorno del mese di arrivo (31 gen + 1 mese = 28/29 feb, non "31 feb"). Altrimenti
 * il giorno viene clampato alla lunghezza del mese di arrivo.
 *
 * Questo e il 29 febbraio sono i due punti dove il codice degli scadenzari
 * cedolari si rompe sempre.
 */
function addMonthsPreserveEom(s: DateString, n: number): DateString {
  assertDate(s);
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const day = Number(s.slice(8, 10));
  const eom = day === lastDayOfMonth(y, m);

  const total = (y * 12 + (m - 1)) + n;
  const ty = Math.floor(total / 12);
  const tm = (total % 12) + 1;
  const tLast = lastDayOfMonth(ty, tm);

  const tday = eom ? tLast : Math.min(day, tLast);
  return `${String(ty).padStart(4, "0")}-${String(tm).padStart(2, "0")}-${String(tday).padStart(2, "0")}`;
}

/** Tutti i giorni di calendario da `from` a `to` inclusi. */
function eachDay(from: DateString, to: DateString): DateString[] {
  assertDate(from, "from");
  assertDate(to, "to");
  const out: DateString[] = [];
  const end = toMs(to);
  for (let t = toMs(from); t <= end; t += DAY_MS) out.push(toISO(t));
  return out;
}

const dayOfWeek = (s: DateString): number => new Date(toMs(s)).getUTCDay(); // 0 = domenica
const isWeekend = (s: DateString): boolean => dayOfWeek(s) === 0 || dayOfWeek(s) === 6;
const endOfMonth = (s: DateString): DateString => {
  assertDate(s);
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  return `${s.slice(0, 7)}-${String(lastDayOfMonth(y, m)).padStart(2, "0")}`;
};
const monthKey = (s: DateString): string => s.slice(0, 7);

/**
 * FORWARD-FILL: l'ultima osservazione riportata avanti. MAI interpolazione, mai
 * back-fill (docs/decisions.md §5).
 *
 * L'SQL restituisce righe sparse, questa funzione fa il fill: così è pura e
 * testabile senza database.
 *
 * @param {string[]} dates griglia ascendente di date
 * @param {Array<object>} rows righe sparse ASCENDENTI per data
 * @param {{dateKey?: string, valueKey?: string}} opts
 * @returns {Array<{date: string, value: any, sourceDate: string|null, filled: boolean}>}
 *   `value: null` per le date PRIMA della prima osservazione — è il caso che deve
 *   diventare `partial: true` a monte, non uno zero silenzioso.
 */
function forwardFill<V = unknown>(
  dates: DateString[],
  rows: ReadonlyArray<Record<string, any>>,
  opts: FillOptions = {}
): Array<FillPoint<V>> {
  const dateKey = opts.dateKey || "date";
  const valueKey = opts.valueKey || "value";

  const sorted = [...rows]
    .map((r) => ({ date: normalizeDate(r[dateKey]), value: r[valueKey] as V }))
    // Type guard, non un filter qualunque: e' quello che dice al compilatore che
    // da qui in giu' `date` non e' piu' nullable.
    .filter((r): r is { date: DateString; value: V } => r.date !== null)
    .sort((a, b) => cmp(a.date, b.date));

  const out: Array<FillPoint<V>> = [];
  let i = 0;
  let lastValue: V | null = null;
  let lastDate: DateString | null = null;

  for (const day of dates) {
    // Avanza il puntatore su tutte le osservazioni fino a `day` incluso.
    // Puntatore mobile, non una riscansione per giorno: O(giorni + righe).
    while (i < sorted.length && cmp(sorted[i].date, day) <= 0) {
      lastValue = sorted[i].value;
      lastDate = sorted[i].date;
      i++;
    }
    out.push({
      date: day,
      value: lastValue,
      sourceDate: lastDate,
      filled: lastDate !== null && lastDate !== day,
    });
  }
  return out;
}

export interface FillOptions {
  dateKey?: string;
  valueKey?: string;
}

export interface FillPoint<V = unknown> {
  date: DateString;
  /** null PRIMA della prima osservazione: e' il caso che a monte diventa `partial`. */
  value: V | null;
  sourceDate: DateString | null;
  filled: boolean;
}

export type FillAt<V = unknown> = Omit<FillPoint<V>, "date">;

/** Crea un lookup forward-fill riutilizzabile su una serie sparsa. */
function forwardFillLookup<V = unknown>(
  rows: ReadonlyArray<Record<string, any>>,
  opts: FillOptions = {}
): (day: DateString) => FillAt<V> {
  const dateKey = opts.dateKey || "date";
  const valueKey = opts.valueKey || "value";
  const sorted = [...rows]
    .map((r) => ({ date: normalizeDate(r[dateKey]), value: r[valueKey] as V }))
    // Type guard, non un filter qualunque: e' quello che dice al compilatore che
    // da qui in giu' `date` non e' piu' nullable.
    .filter((r): r is { date: DateString; value: V } => r.date !== null)
    .sort((a, b) => cmp(a.date, b.date));

  return function at(day: DateString): FillAt<V> {
    // Ricerca binaria dell'ultima osservazione <= day.
    let lo = 0;
    let hi = sorted.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cmp(sorted[mid].date, day) <= 0) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (found === -1) return { value: null, sourceDate: null, filled: false };
    return {
      value: sorted[found].value,
      sourceDate: sorted[found].date,
      filled: sorted[found].date !== day,
    };
  };
}

/**
 * Griglia di date per un grafico, con downsampling in base al range.
 * Cap a ~800 punti: oltre, un grafico da 900px disegna più punti che pixel.
 */
const MAX_POINTS = 800;

/** Granularita' della griglia di un grafico. */
export type Granularity = "day" | "week" | "month";

function chooseGranularity(from: DateString, to: DateString, requested: Granularity | "auto" = "auto"): Granularity {
  if (requested && requested !== "auto") return requested;
  const days = daysBetween(from, to);
  if (days <= 366) return "day";
  if (days <= 366 * 5) return "week";
  return "month";
}

/**
 * Riduce la griglia giornaliera secondo la granularità.
 * - day: tutti i giorni
 * - week: i venerdì (più sempre l'ultimo giorno, che è `asOf`)
 * - month: fine mese (più sempre l'ultimo giorno)
 */
function buildGrid(
  from: DateString,
  to: DateString,
  granularity: Granularity | "auto" = "auto"
): { dates: DateString[]; granularity: Granularity } {
  const gran = chooseGranularity(from, to, granularity);
  const all = eachDay(from, to);
  if (all.length === 0) return { dates: [], granularity: gran };

  let dates: DateString[];
  if (gran === "day") {
    dates = all;
  } else if (gran === "week") {
    dates = all.filter((s) => dayOfWeek(s) === 5);
  } else {
    dates = all.filter((s) => isEom(s));
  }

  // L'ultimo giorno (asOf) deve esserci sempre: è il valore che l'utente legge
  // come "oggi", e perderlo perché non è un venerdì è inaccettabile.
  const last = all[all.length - 1];
  if (dates.length === 0 || dates[dates.length - 1] !== last) dates.push(last);
  // Idem per il primo: dà l'origine della serie.
  if (dates[0] !== all[0]) dates.unshift(all[0]);

  // Cap difensivo se il range è enorme anche dopo il downsampling.
  if (dates.length > MAX_POINTS) {
    const step = Math.ceil(dates.length / MAX_POINTS);
    const capped = dates.filter((_, i) => i % step === 0);
    if (capped[capped.length - 1] !== last) capped.push(last);
    dates = capped;
  }

  return { dates, granularity: gran };
}

/**
 * Risolve un range simbolico in {from, to}. `today` è un PARAMETRO: il dominio non
 * chiama mai Date.now().
 */
function resolveRange(
  range: string | null | undefined,
  today: DateString,
  earliest: DateString | null = null
): { from: DateString; to: DateString } {
  assertDate(today, "today");
  const r = String(range || "1Y").toUpperCase();
  let from: DateString;
  switch (r) {
    case "1M": from = addMonthsPreserveEom(today, -1); break;
    case "3M": from = addMonthsPreserveEom(today, -3); break;
    case "6M": from = addMonthsPreserveEom(today, -6); break;
    case "YTD": from = `${today.slice(0, 4)}-01-01`; break;
    case "1Y": from = addMonthsPreserveEom(today, -12); break;
    case "5Y": from = addMonthsPreserveEom(today, -60); break;
    case "ALL": from = earliest || addMonthsPreserveEom(today, -12); break;
    default: from = addMonthsPreserveEom(today, -12);
  }
  // Non partire prima della prima transazione: mesi di zeri davanti al grafico
  // sono rumore, non informazione.
  if (earliest && cmp(from, earliest) < 0) from = earliest;
  return { from, to: today };
}

export { DAY_MS, DATE_RE, assertDate, toMs, toISO, normalizeDate, cmp, min, max, addDays, daysBetween, lastDayOfMonth, isEom, addMonthsPreserveEom, eachDay, dayOfWeek, isWeekend, endOfMonth, monthKey, forwardFill, forwardFillLookup, chooseGranularity, buildGrid, resolveRange, MAX_POINTS };
