// Metriche di prezzo e di rischio calcolate SUI NOSTRI DATI.
//
// Perché non prenderle dal provider: Yahoo pubblica beta e variazione a 52
// settimane, ma non le dà per un BTP a pricing manuale — e su un BTP i prezzi in
// archivio sono l'UNICO dato che esiste. Calcolarle qui significa che l'analisi ha
// numeri di rischio anche dove la copertura del provider è zero, e che quei numeri
// sono verificabili con un unit test invece di essere presi per buoni.
//
// Modulo PURO (docs/decisions.md §7): solo decimal.js e moduli locali, nessun I/O,
// e la data di riferimento è un PARAMETRO — niente `Date.now()`, altrimenti la
// stessa serie darebbe risultati diversi a ogni esecuzione del test.
//
// Tutti gli output sono STRINGHE decimali (o null quando la serie non basta a
// calcolarli). Le variazioni sono FRAZIONI, non percentuali: 0,0345 = +3,45%,
// coerente con `coupon_rate` (docs/decisions.md §9).
import { d, isBlank, safeDiv } from "./money";
import { addDays, addMonthsPreserveEom, cmp, daysBetween } from "./calendar";
import type { DateString, DecimalString } from "../types";

/** Una osservazione di prezzo: la forma che `repo/prices.series()` restituisce. */
export interface PricePoint {
  date: DateString;
  close: DecimalString | null;
}

export interface HorizonReturn {
  /** Etichetta dell'orizzonte: "1m", "3m", "6m", "12m". */
  horizon: string;
  /** Data dell'osservazione effettivamente usata come base (≤ data richiesta). */
  from: DateString;
  fromClose: DecimalString;
  /** Variazione come frazione: (ultimo − base) / base. */
  change: DecimalString;
}

export interface RiskMetrics {
  points: number;
  from: DateString | null;
  to: DateString | null;
  last: DecimalString | null;
  /** Giorni di calendario coperti dalla serie: dice se le altre metriche hanno senso. */
  spanDays: number;
  /**
   * `"daily"` se le osservazioni sono ravvicinate (mediana dei divari ≤ 4 giorni),
   * `"sparse"` altrimenti — il caso di un bond a prezzo inserito a mano.
   *
   * Su una serie sparsa volatilità, medie mobili e trend NON vengono calcolati: le
   * loro definizioni presuppongono il passo giornaliero, e presentarli comunque
   * darebbe numeri sbagliati con un'etichetta rassicurante.
   */
  granularity: "daily" | "sparse" | null;
  high52w: { date: DateString; close: DecimalString } | null;
  low52w: { date: DateString; close: DecimalString } | null;
  /** Distanza dal massimo a 52 settimane, frazione NEGATIVA o zero. */
  fromHigh52w: DecimalString | null;
  /** Distanza dal minimo a 52 settimane, frazione positiva o zero. */
  fromLow52w: DecimalString | null;
  returns: HorizonReturn[];
  /**
   * Deviazione standard dei rendimenti giornalieri annualizzata (√252).
   *
   * `null` se la serie è `sparse` o se i rendimenti giornalieri utilizzabili sono
   * meno di 20: √252 vale solo su un passo giornaliero.
   */
  volatility: DecimalString | null;
  maxDrawdown: {
    /** Frazione NEGATIVA: −0,32 = −32% dal massimo precedente. */
    depth: DecimalString;
    peakDate: DateString;
    troughDate: DateString;
  } | null;
  sma50: DecimalString | null;
  sma200: DecimalString | null;
  /** "sopra", "sotto" o "misto" rispetto alle due medie. `null` senza SMA50. */
  trend: string | null;
}

/** Giorni di borsa in un anno: la convenzione per annualizzare una volatilità giornaliera. */
const TRADING_DAYS = 252;
/**
 * Quanto può essere vecchia l'osservazione usata come base di un orizzonte.
 *
 * 15 giorni coprono un ponte festivo o una serie con qualche buco; oltre, il
 * rendimento apparterrebbe a un periodo diverso da quello dichiarato.
 */
const MAX_BASE_GAP_DAYS = 15;
/** Mediana dei divari oltre la quale la serie non è più "giornaliera". */
const MAX_DAILY_GAP_DAYS = 4;
/** Divario oltre il quale due osservazioni non fanno un rendimento giornaliero. */
const MAX_RETURN_GAP_DAYS = 7;
const HORIZONS: Array<[string, number]> = [
  ["1m", 1],
  ["3m", 3],
  ["6m", 6],
  ["12m", 12],
];

/** Osservazioni utilizzabili (chiusura presente e non zero), ordinate per data. */
function usable(series: readonly PricePoint[]): Array<{ date: DateString; close: DecimalString }> {
  return series
    .filter((p): p is { date: DateString; close: DecimalString } => {
      if (!p || typeof p.date !== "string") return false;
      if (isBlank(p.close)) return false;
      // Uno zero non è un prezzo: sarebbe un buco nei dati travestito da crollo
      // (docs/decisions.md §5), e in un rapporto diventerebbe una divisione per zero.
      return !d(p.close).isZero();
    })
    .slice()
    .sort((a, b) => cmp(a.date, b.date));
}

/**
 * L'ultima osservazione con data ≤ `date`.
 *
 * Forward-fill (docs/decisions.md §5): il 15 agosto la borsa è chiusa, quindi
 * "sei mesi fa" cade normalmente su un giorno senza prezzo e la risposta corretta è
 * l'ultima chiusura nota, non un'interpolazione.
 */
function asOf(
  points: ReadonlyArray<{ date: DateString; close: DecimalString }>,
  date: DateString
): { date: DateString; close: DecimalString } | null {
  let found = null;
  for (const p of points) {
    if (cmp(p.date, date) <= 0) found = p;
    else break;
  }
  return found;
}

/** Media semplice delle ultime `n` chiusure. `null` se non ce ne sono almeno `n`. */
function sma(
  points: ReadonlyArray<{ date: DateString; close: DecimalString }>,
  n: number
): DecimalString | null {
  if (points.length < n) return null;
  const window = points.slice(points.length - n);
  let acc = d(0);
  for (const p of window) acc = acc.plus(d(p.close));
  return acc.div(n).toDecimalPlaces(8).toFixed();
}

/**
 * Metriche di rischio della serie, viste da `asOfDate`.
 *
 * `asOfDate` è la data "oggi" e serve a due cose: delimitare la finestra a 52
 * settimane e ancorare gli orizzonti dei rendimenti. Passarla invece di leggere
 * l'orologio è ciò che rende il modulo deterministico.
 */
function riskMetrics(series: readonly PricePoint[], asOfDate: DateString): RiskMetrics {
  // Si taglia SOPRA `asOfDate` una volta sola, all'ingresso: senza, `last`, le medie
  // mobili e il drawdown userebbero l'ultimo punto della serie qualunque sia la data
  // di riferimento — e il modulo si presenta come deterministico rispetto a
  // `asOfDate`. Dalla route non capita (la query taglia già), ma capiterebbe il
  // giorno in cui si chiede una data storica o si inserisce a mano un prezzo con
  // data futura.
  const points = usable(series).filter((p) => cmp(p.date, asOfDate) <= 0);
  const empty: RiskMetrics = {
    points: 0,
    from: null,
    to: null,
    last: null,
    spanDays: 0,
    granularity: null,
    high52w: null,
    low52w: null,
    fromHigh52w: null,
    fromLow52w: null,
    returns: [],
    volatility: null,
    maxDrawdown: null,
    sma50: null,
    sma200: null,
    trend: null,
  };
  if (points.length === 0) return empty;

  const first = points[0];
  const lastPoint = points[points.length - 1];
  const last = d(lastPoint.close);

  // Finestra a 52 settimane: 364 giorni indietro dalla data di riferimento (52 × 7,
  // non "un anno", così la finestra cade sempre sullo stesso giorno della settimana).
  const windowStart = addDays(asOfDate, -364);
  const window = points.filter((p) => cmp(p.date, windowStart) >= 0);
  let high52w: { date: DateString; close: DecimalString } | null = null;
  let low52w: { date: DateString; close: DecimalString } | null = null;
  for (const p of window) {
    // Si copiano solo data e chiusura: le righe in ingresso possono portare con sé
    // mezzo record di `prices_daily` (volume, fetchedAt, adjClose…) e questa forma
    // finisce dentro un prompt a pagamento — allargarla costa token per niente.
    if (!high52w || d(p.close).gt(d(high52w.close))) high52w = { date: p.date, close: p.close };
    if (!low52w || d(p.close).lt(d(low52w.close))) low52w = { date: p.date, close: p.close };
  }

  const returns: HorizonReturn[] = [];
  for (const [horizon, months] of HORIZONS) {
    const target = addMonthsPreserveEom(asOfDate, -months);
    const base = asOf(points, target);
    // Se la base coincide con l'ultima osservazione non c'è nessun periodo da
    // misurare: una serie di due settimane non ha un rendimento a 12 mesi, e
    // restituirne uno pari a zero sarebbe una bugia.
    if (!base || base.date === lastPoint.date) continue;
    // E il forward-fill ha un limite: se l'ultima chiusura nota prima della data
    // richiesta è di mesi prima, quel numero non è "il rendimento a 1 mese" — è il
    // rendimento di un periodo diverso con l'etichetta sbagliata, che è peggio di un
    // dato assente. Oltre `MAX_BASE_GAP_DAYS` l'orizzonte si omette.
    if (daysBetween(base.date, target) > MAX_BASE_GAP_DAYS) continue;
    const change = safeDiv(last.minus(d(base.close)), d(base.close));
    if (change === null) continue;
    returns.push({
      horizon,
      from: base.date,
      fromClose: base.close,
      change: change.toDecimalPlaces(8).toFixed(),
    });
  }

  // Granularità della serie. NON è un dettaglio decorativo: √252 annualizza
  // rendimenti GIORNALIERI, e su un BTP a pricing manuale — dove il prezzo si
  // inserisce una volta al mese, che per le obbligazioni è la strada normale
  // (docs/decisions.md §9) — ogni "rendimento giornaliero" è in realtà mensile.
  // Annualizzarlo con √252 invece di √12 sovrastima la volatilità di ~4,6 volte, e
  // quel numero finirebbe in un prompt che lo dichiara "annualizzato".
  //
  // Mediana e non media dei divari: un solo buco lungo (una borsa chiusa una
  // settimana, un backfill parziale) non deve declassare una serie giornaliera.
  const gaps = [];
  for (let i = 1; i < points.length; i++) gaps.push(daysBetween(points[i - 1].date, points[i].date));
  const sortedGaps = gaps.slice().sort((a, b) => a - b);
  const medianGap = sortedGaps.length === 0 ? null : sortedGaps[Math.floor(sortedGaps.length / 2)];
  // 4 giorni di mediana coprono i fine settimana e i festivi; oltre, la serie non è
  // giornaliera e le metriche che presuppongono il passo giornaliero si omettono.
  const granularity: RiskMetrics["granularity"] =
    medianGap === null ? null : medianGap <= MAX_DAILY_GAP_DAYS ? "daily" : "sparse";

  // Volatilità: deviazione standard CAMPIONARIA (n−1) dei rendimenti semplici
  // giornalieri, annualizzata con √252. Rendimenti semplici e non logaritmici:
  // sono quelli che il resto dell'app usa, e sulla scala di un giorno la differenza
  // è di terzo ordine.
  let volatility: DecimalString | null = null;
  const daily = [];
  for (let i = 1; i < points.length; i++) {
    // Un divario oltre una settimana non è un rendimento giornaliero: si salta
    // invece di infilarlo nella stessa deviazione standard degli altri.
    if (daysBetween(points[i - 1].date, points[i].date) > MAX_RETURN_GAP_DAYS) continue;
    const r = safeDiv(d(points[i].close).minus(d(points[i - 1].close)), d(points[i - 1].close));
    if (r !== null) daily.push(r);
  }
  if (granularity === "daily" && daily.length >= 20) {
    let sum = d(0);
    for (const r of daily) sum = sum.plus(r);
    const mean = sum.div(daily.length);
    let sq = d(0);
    for (const r of daily) sq = sq.plus(r.minus(mean).pow(2));
    const variance = sq.div(daily.length - 1);
    volatility = variance.times(TRADING_DAYS).sqrt().toDecimalPlaces(6).toFixed();
  }

  // Max drawdown: la peggior discesa da un massimo PRECEDENTE. Si scorre una volta
  // tenendo il massimo corrente — il minimo successivo al massimo, non il minimo
  // assoluto della serie, che darebbe un numero senza significato quando il minimo
  // viene prima del massimo.
  let maxDrawdown: RiskMetrics["maxDrawdown"] = null;
  let peak = points[0];
  let worst = d(0);
  for (const p of points) {
    if (d(p.close).gt(d(peak.close))) {
      peak = p;
      continue;
    }
    const dd = safeDiv(d(p.close).minus(d(peak.close)), d(peak.close));
    if (dd !== null && dd.lt(worst)) {
      worst = dd;
      maxDrawdown = {
        depth: dd.toDecimalPlaces(8).toFixed(),
        peakDate: peak.date,
        troughDate: p.date,
      };
    }
  }

  // Le medie mobili si chiamano "a 50 e 200 giorni": su una serie mensile le ultime
  // 50 osservazioni sono quattro anni, e l'etichetta sarebbe falsa. Su una serie
  // sparsa si omettono, e la lacuna viene dichiarata.
  const sma50 = granularity === "daily" ? sma(points, 50) : null;
  const sma200 = granularity === "daily" ? sma(points, 200) : null;
  let trend: string | null = null;
  if (sma50 !== null) {
    const above50 = last.gte(d(sma50));
    const above200 = sma200 === null ? above50 : last.gte(d(sma200));
    trend = above50 && above200 ? "sopra" : !above50 && !above200 ? "sotto" : "misto";
  }

  return {
    points: points.length,
    from: first.date,
    to: lastPoint.date,
    last: lastPoint.close,
    spanDays: daysBetween(first.date, lastPoint.date),
    granularity,
    high52w,
    low52w,
    fromHigh52w:
      high52w === null
        ? null
        : (safeDiv(last.minus(d(high52w.close)), d(high52w.close))?.toDecimalPlaces(8).toFixed() ?? null),
    fromLow52w:
      low52w === null
        ? null
        : (safeDiv(last.minus(d(low52w.close)), d(low52w.close))?.toDecimalPlaces(8).toFixed() ?? null),
    returns,
    volatility,
    maxDrawdown,
    sma50,
    sma200,
    trend,
  };
}

export { riskMetrics, TRADING_DAYS, MAX_BASE_GAP_DAYS, MAX_DAILY_GAP_DAYS, MAX_RETURN_GAP_DAYS, asOf as _asOf, sma as _sma };
