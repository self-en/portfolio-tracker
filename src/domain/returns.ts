// Metriche di rendimento. Puro: date come stringhe, nessun Date.now().
import { D, d, ZERO, ONE, isBlank } from "./money";
import * as cal from "./calendar";

const DAYS_PER_YEAR = 365;

/**
 * Rendimento semplice = (valore - investito netto) / investito netto.
 *
 * Mostrato SOLO sulle righe di posizione come "P&L %". A livello di portafoglio
 * con versamenti irregolari è fuorviante e non va mai usato come cifra
 * principale.
 * @returns {string|null}
 */
function simpleReturn(value, netInvested) {
  const ni = d(netInvested);
  if (ni.isZero()) return null;
  return d(value).minus(ni).div(ni).toDecimalPlaces(8, D.ROUND_HALF_EVEN).toFixed();
}

/**
 * TWR giornaliero VERO (non Modified Dietz: la serie giornaliera esiste già).
 *
 *   r_t = (V_t - F_t) / V_{t-1} - 1        TWR = Π(1 + r_t) - 1
 *
 * dove F_t è il flusso esterno netto in valuta base del giorno t (positivo = denaro
 * che ENTRA nel portafoglio).
 *
 * È la misura che ISOLA la performance dal timing dei versamenti: è il numero da
 * confrontare con un indice.
 *
 * @param {Array<{date: string, value: any}>} points serie del valore, ascendente
 * @param {Map<string, any>|Object} flowsByDate flusso netto ENTRANTE per data
 * @returns {{total: string|null, annualized: string|null, days: number, segments: number}}
 */
function twr(points, flowsByDate = new Map()) {
  const getFlow = (date) => {
    const v = flowsByDate instanceof Map ? flowsByDate.get(date) : flowsByDate[date];
    return isBlank(v) ? ZERO : d(v);
  };

  const usable = (points || []).filter((p) => !isBlank(p.value));
  if (usable.length < 2) {
    return { total: null, annualized: null, days: 0, segments: 0 };
  }

  let product = ONE;
  let prev = d(usable[0].value);
  let segments = 1;

  for (let i = 1; i < usable.length; i++) {
    const v = d(usable[i].value);
    const f = getFlow(usable[i].date);

    if (prev.isZero()) {
      // GUARDIA su V_{t-1} = 0: il rendimento non è definito (divisione per zero).
      // Si RIAVVIA la catena invece di propagare NaN o saltare il periodo: succede
      // davvero quando si liquida tutto e poi si ricompra.
      prev = v;
      if (!v.isZero()) segments += 1;
      continue;
    }

    const r = v.minus(f).div(prev).minus(ONE);
    product = product.times(ONE.plus(r));
    prev = v;
  }

  const total = product.minus(ONE);
  const days = cal.daysBetween(usable[0].date, usable[usable.length - 1].date);

  let annualized = null;
  if (days > 0) {
    const base = ONE.plus(total);
    // Una perdita totale (base <= 0) non è annualizzabile: pow di un negativo con
    // esponente frazionario non è reale.
    if (base.gt(0)) {
      annualized = base
        .pow(d(DAYS_PER_YEAR).div(days))
        .minus(ONE)
        .toDecimalPlaces(8, D.ROUND_HALF_EVEN)
        .toFixed();
    }
  }

  return {
    total: total.toDecimalPlaces(8, D.ROUND_HALF_EVEN).toFixed(),
    annualized,
    days,
    segments,
  };
}

/**
 * Aggrega una lista di flussi in un totale per data.
 * @param {Array<{date: string, amountBase: any}>} flows
 * @returns {Map<string, Decimal>}
 */
function aggregateFlows(flows) {
  const map = new Map();
  for (const f of flows || []) {
    const date = cal.normalizeDate(f.date);
    if (!date) continue;
    map.set(date, d(map.get(date)).plus(d(f.amountBase ?? f.amount)));
  }
  return map;
}

/**
 * Flusso ENTRANTE per data, a partire dai net_amount (che hanno il segno del
 * flusso di cassa dell'INVESTITORE: BUY negativo). Entrante = -net_amount.
 */
function inflowsByDate(flows) {
  const map = new Map();
  for (const [date, amount] of aggregateFlows(flows)) map.set(date, amount.negated());
  return map;
}

/**
 * Tipi che contano come CAPITALE INVESTITO.
 *
 * Deliberatamente SENZA i redditi: incassare un dividendo non riduce quanto hai
 * investito, quindi la linea "investito netto" del grafico non deve scendere quando
 * arriva una cedola. I redditi restano invece flussi esterni a pieno titolo per TWR
 * e XIRR, dove un incasso È un'uscita dal portafoglio — sono due aggregazioni
 * diverse della stessa lista di flussi, e confonderle fa scendere la linea
 * dell'investito a ogni stacco.
 */
const CAPITAL_TYPES = new Set(["BUY", "SELL", "FEE", "TAX", "RETURN_OF_CAPITAL"]);

/** Investito netto cumulato = -Σ net_amount sui soli flussi di CAPITALE. */
function netInvestedSeries(flows, dates) {
  const capital = (flows || []).filter((f) => !f.type || CAPITAL_TYPES.has(f.type));
  const byDate = aggregateFlows(capital);
  const out = [];
  let acc = ZERO;
  const sorted = [...byDate.keys()].sort(cal.cmp);
  let i = 0;
  for (const day of dates) {
    while (i < sorted.length && cal.cmp(sorted[i], day) <= 0) {
      acc = acc.plus(byDate.get(sorted[i]));
      i++;
    }
    out.push({ date: day, netInvested: acc.negated() });
  }
  return out;
}

/** f(r) = Σ cf_i (1+r)^(-d_i/365) */
function npv(cashflows, rate) {
  const base = ONE.plus(d(rate));
  let acc = ZERO;
  for (const cf of cashflows) {
    const exp = d(cf.days).div(DAYS_PER_YEAR).negated();
    acc = acc.plus(d(cf.amount).times(base.pow(exp)));
  }
  return acc;
}

/** f'(r) = Σ cf_i × (-d_i/365) × (1+r)^(-d_i/365 - 1) */
function npvDerivative(cashflows, rate) {
  const base = ONE.plus(d(rate));
  let acc = ZERO;
  for (const cf of cashflows) {
    const k = d(cf.days).div(DAYS_PER_YEAR).negated();
    if (k.isZero()) continue;
    acc = acc.plus(d(cf.amount).times(k).times(base.pow(k.minus(ONE))));
  }
  return acc;
}

const XIRR_TOL = new D("1e-9");
const XIRR_MAX_ITER = 100;
const BISECT_LO = new D("-0.9999");
const BISECT_HI = new D(10);

/**
 * MWR / XIRR: Newton-Raphson con derivata analitica, e FALLBACK OBBLIGATORIO a
 * bisezione.
 *
 * Il fallback non è teorico: Newton diverge realmente su insiemi di flussi
 * irregolari quando f'(r) ≈ 0, e senza rete di sicurezza restituirebbe un numero
 * assurdo o NaN.
 *
 * @param {Array<{date: string, amount: any}>} cashflows segno dell'INVESTITORE
 *   (versamento negativo, incasso positivo), valore terminale incluso
 * @returns {{rate: string, method: string, iterations: number}|null}
 *   null se non esiste almeno un flusso positivo E uno negativo.
 */
function xirr(cashflows) {
  const flows = (cashflows || [])
    .map((c) => ({ date: cal.normalizeDate(c.date), amount: d(c.amount) }))
    .filter((c) => c.date && !c.amount.isZero())
    .sort((a, b) => cal.cmp(a.date, b.date));

  if (flows.length < 2) return null;

  const hasPositive = flows.some((f) => f.amount.gt(0));
  const hasNegative = flows.some((f) => f.amount.lt(0));
  // Senza un flusso di entrambi i segni l'equazione non ha soluzione finanziaria:
  // meglio null che un numero inventato.
  if (!hasPositive || !hasNegative) return null;

  const start = flows[0].date;
  const cf = flows.map((f) => ({ amount: f.amount, days: cal.daysBetween(start, f.date) }));

  // --- Newton-Raphson ---
  let rate = new D("0.1");
  for (let i = 0; i < XIRR_MAX_ITER; i++) {
    let f;
    let fp;
    try {
      f = npv(cf, rate);
      fp = npvDerivative(cf, rate);
    } catch {
      break; // pow fuori dominio: si passa alla bisezione
    }
    if (f.abs().lt(XIRR_TOL)) {
      return {
        rate: rate.toDecimalPlaces(8, D.ROUND_HALF_EVEN).toFixed(),
        method: "newton",
        iterations: i + 1,
      };
    }
    if (fp.isZero() || !fp.isFinite()) break; // derivata piatta: Newton è finito
    const next = rate.minus(f.div(fp));
    if (!next.isFinite() || next.lte(-1)) break; // uscito dal dominio
    if (next.minus(rate).abs().lt(XIRR_TOL)) {
      return {
        rate: next.toDecimalPlaces(8, D.ROUND_HALF_EVEN).toFixed(),
        method: "newton",
        iterations: i + 1,
      };
    }
    rate = next;
  }

  // --- Bisezione su [-0.9999, 10] ---
  let lo = BISECT_LO;
  let hi = BISECT_HI;
  let flo;
  let fhi;
  try {
    flo = npv(cf, lo);
    fhi = npv(cf, hi);
  } catch {
    return null;
  }
  if (flo.isZero()) return { rate: lo.toFixed(), method: "bisection", iterations: 0 };
  if (fhi.isZero()) return { rate: hi.toFixed(), method: "bisection", iterations: 0 };
  // Nessun cambio di segno nell'intervallo → nessuna radice da trovare qui.
  if (flo.s === fhi.s) return null;

  for (let i = 0; i < 200; i++) {
    const mid = lo.plus(hi).div(2);
    const fmid = npv(cf, mid);
    if (fmid.abs().lt(XIRR_TOL) || hi.minus(lo).abs().lt(XIRR_TOL)) {
      return {
        rate: mid.toDecimalPlaces(8, D.ROUND_HALF_EVEN).toFixed(),
        method: "bisection",
        iterations: i + 1,
      };
    }
    if (fmid.s === flo.s) {
      lo = mid;
      flo = fmid;
    } else {
      hi = mid;
      fhi = fmid;
    }
  }

  return {
    rate: lo.plus(hi).div(2).toDecimalPlaces(8, D.ROUND_HALF_EVEN).toFixed(),
    method: "bisection",
    iterations: 200,
  };
}

/**
 * XIRR di un portafoglio: flussi del ledger più il valore terminale come incasso
 * finale.
 */
function portfolioXirr(flows, terminalValue, asOf) {
  const cashflows = (flows || []).map((f) => ({ date: f.date, amount: d(f.amountBase ?? f.amount) }));
  if (!isBlank(terminalValue)) {
    cashflows.push({ date: cal.normalizeDate(asOf), amount: d(terminalValue) });
  }
  return xirr(cashflows);
}

/** Suddivide TWR e XIRR per anno civile. */
function byYear(points, flows, opts = {}) {
  const inflow = inflowsByDate(flows);
  const usable = (points || []).filter((p) => !isBlank(p.value));
  if (usable.length < 2) return [];

  const years = [...new Set(usable.map((p) => p.date.slice(0, 4)))].sort();
  const out = [];

  for (const year of years) {
    // Il punto di partenza è l'ULTIMO punto dell'anno precedente: il rendimento di
    // gennaio si misura dal 31 dicembre, non dal 1° gennaio.
    const idxFirst = usable.findIndex((p) => p.date.slice(0, 4) === year);
    const from = idxFirst > 0 ? idxFirst - 1 : 0;
    const slice = usable.filter((p, i) => i >= from && p.date.slice(0, 4) <= year);
    if (slice.length < 2) continue;

    const t = twr(slice, inflow);
    const yearFlows = (flows || []).filter((f) => cal.normalizeDate(f.date)?.slice(0, 4) === year);
    const openingValue = d(slice[0].value);
    const closingValue = d(slice[slice.length - 1].value);

    // XIRR annuale: valore di apertura come versamento iniziale, flussi dell'anno,
    // valore di chiusura come incasso finale.
    const cashflows = [
      { date: slice[0].date, amount: openingValue.negated() },
      ...yearFlows.map((f) => ({ date: f.date, amount: d(f.amountBase ?? f.amount) })),
      { date: slice[slice.length - 1].date, amount: closingValue },
    ];
    const x = xirr(cashflows);

    out.push({ year, twr: t.total, xirr: x ? x.rate : null });
  }

  return out;
}

export { DAYS_PER_YEAR, CAPITAL_TYPES, simpleReturn, twr, aggregateFlows, inflowsByDate, netInvestedSeries, npv, npvDerivative, xirr, portfolioXirr, byYear };
