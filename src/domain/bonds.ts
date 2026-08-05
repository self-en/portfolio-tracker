// Obbligazioni: scadenzario cedolare, rateo, valorizzazione in % del nominale.
//
// Copertura provider pari a zero sui BTP (verificato in Fase 0), quindi questo
// modulo non è un fallback: è il motore che fa funzionare il calendario cedole.
import { D, d, HUNDRED, ZERO, safeDiv } from "./money";
import * as cal from "./calendar";
import type Decimal from "decimal.js";
import type { Numeric } from "./money";
import type { DateString, DecimalString } from "../types";
import type { InstrumentLike } from "./types";

/** Un periodo cedolare dello scadenzario. */
export interface CouponPeriod {
  periodStart: DateString;
  periodEnd: DateString;
  payDate: DateString;
  /** Confini QUASI-cedolari: sono il denominatore del rateo ACT/ACT-ICMA. */
  quasiStart: DateString;
  quasiEnd: DateString;
  amountPer100: DecimalString;
  irregular: boolean;
}

const DAY_COUNTS = ["ACT/ACT-ICMA", "30E/360", "ACT/365F", "ACT/360"];

/** Mesi tra due cedole. frequency 0 (zero coupon) non ha passo. */
const monthsPerPeriod = (frequency: number | null | undefined): number | null => {
  const f = Number(frequency);
  if (!f || f <= 0) return null;
  return 12 / f;
};

/**
 * Giorni secondo la convenzione 30E/360 (eurobond): ogni mese vale 30 giorni,
 * il 31 diventa 30.
 */
function days30E360(from: DateString, to: DateString): number {
  const y1 = Number(from.slice(0, 4));
  const m1 = Number(from.slice(5, 7));
  const y2 = Number(to.slice(0, 4));
  const m2 = Number(to.slice(5, 7));
  const d1 = Math.min(Number(from.slice(8, 10)), 30);
  const d2 = Math.min(Number(to.slice(8, 10)), 30);
  return 360 * (y2 - y1) + 30 * (m2 - m1) + (d2 - d1);
}

/**
 * Frazione di ANNO maturata tra `start` e `settle`.
 *
 * ACT/ACT-ICMA è definita rispetto al periodo cedolare, non all'anno: la
 * frazione è (giorni maturati / giorni del periodo) / frequenza. È la convenzione
 * dei BTP, ed è il default.
 *
 * @returns {Decimal} frazione d'anno
 */
function dayCountFraction(
  convention: string | null | undefined,
  start: DateString,
  settle: DateString,
  periodStart: DateString,
  periodEnd: DateString,
  frequency: number | null | undefined
): Decimal {
  const conv = convention && DAY_COUNTS.includes(convention) ? convention : "ACT/ACT-ICMA";

  if (conv === "ACT/ACT-ICMA") {
    const periodDays = cal.daysBetween(periodStart, periodEnd);
    if (periodDays <= 0) return ZERO;
    const accruedDays = cal.daysBetween(start, settle);
    const f = Number(frequency) || 1;
    return d(accruedDays).div(periodDays).div(f);
  }
  if (conv === "30E/360") return d(days30E360(start, settle)).div(360);
  if (conv === "ACT/365F") return d(cal.daysBetween(start, settle)).div(365);
  return d(cal.daysBetween(start, settle)).div(360); // ACT/360
}

/**
 * Scadenzario cedolare, GENERATO ALL'INDIETRO DALLA SCADENZA a passi di
 * 12/frequency mesi.
 *
 * All'indietro è come funzionano gli scadenzari reali, e mette il periodo
 * irregolare (corto o lungo) all'INIZIO, dove deve stare: generando in avanti
 * dalla prima cedola, l'irregolarità finirebbe sull'ultimo periodo, cioè su una
 * data — la scadenza — che è invece quella certa.
 *
 * @param {object} bond
 * @param {string} bond.maturityDate 'YYYY-MM-DD' (obbligatoria)
 * @param {string} [bond.firstCouponDate] data della PRIMA cedola
 * @param {number} bond.couponFrequency 0|1|2|4|12 (0 = zero coupon)
 * @param {string|number} [bond.couponRate] frazione annua (0.0345 = 3,45%)
 * @param {string} [bond.dayCount]
 * @returns {Array<{periodStart, periodEnd, payDate, amountPer100, irregular}>}
 */
function couponSchedule(bond: InstrumentLike) {
  const maturity = cal.normalizeDate(bond.maturityDate);
  if (!maturity) throw new TypeError("couponSchedule richiede maturityDate");

  const frequency = Number(bond.couponFrequency);
  const step = monthsPerPeriod(frequency);
  // Zero coupon: nessuna cedola, solo il rimborso a scadenza.
  if (!step) return [];

  const rate = d(bond.couponRate, 0);
  if (rate.isZero()) return [];

  const couponPer100 = rate.times(HUNDRED).div(frequency);
  const dayCount = bond.dayCount || "ACT/ACT-ICMA";

  // `anchor` è ciò che l'utente ha dichiarato come inizio della vita cedolare.
  // Senza, si risale di 200 periodi: copre qualsiasi titolo realistico.
  const anchor =
    cal.normalizeDate(bond.firstCouponDate) ||
    cal.addMonthsPreserveEom(maturity, -step * 200);

  // CATENA DI QUASI-DATE, all'indietro dalla scadenza a passi di `step` mesi.
  // È la griglia canonica del titolo: la scadenza è la data certa, quindi è da
  // lì che si ancora. Generando in avanti dalla prima cedola, l'irregolarità
  // finirebbe sull'ULTIMO periodo, cioè proprio sulla data che non è mai
  // irregolare.
  const chain = [maturity];
  for (let k = 1; k <= 2400; k++) {
    const cand = cal.addMonthsPreserveEom(maturity, -step * k);
    chain.unshift(cand);
    if (cal.cmp(cand, anchor) <= 0) {
      // Se la catena atterra ESATTAMENTE sull'ancora, serve una quasi-data in più:
      // è l'inizio del primo periodo di maturazione.
      if (cand === anchor) chain.unshift(cal.addMonthsPreserveEom(maturity, -step * (k + 1)));
      break;
    }
  }

  // Dove inizia a pagare, e da quando matura.
  //
  // - ancora SULLA griglia  → è la prima cedola pagata; matura dalla quasi-data
  //                           precedente.
  // - ancora FUORI griglia  → è la data di godimento (emissione): la prima cedola
  //                           pagata è la prima quasi-data successiva, e il primo
  //                           periodo è uno STUB corto che matura dall'ancora.
  //                           Le cedole successive tornano sulla griglia — che è
  //                           il comportamento di mercato: la scadenza e le date
  //                           cedola sono certe, solo il PRIMO IMPORTO è ridotto.
  const onGrid = chain.includes(anchor);
  const firstPayIdx = onGrid
    ? chain.indexOf(anchor)
    : chain.findIndex((x) => cal.cmp(x, anchor) > 0);
  if (firstPayIdx <= 0) return [];

  const out = [];
  for (let i = firstPayIdx; i < chain.length; i++) {
    const payDate = chain[i];
    const quasiStart = chain[i - 1]; // inizio del periodo quasi-cedolare ICMA
    // Solo il primo periodo può maturare da una data fuori griglia.
    const periodStart = i === firstPayIdx && !onGrid ? anchor : quasiStart;
    const irregular = periodStart !== quasiStart;

    let amountPer100 = couponPer100;
    if (irregular) {
      // Stub: si prorata sul periodo quasi-cedolare, così una prima cedola di 3
      // mesi su un semestrale paga esattamente metà cedola.
      const frac = dayCountFraction(
        dayCount,
        periodStart,
        payDate,
        quasiStart,
        payDate,
        frequency
      );
      amountPer100 = rate.times(HUNDRED).times(frac);
    }

    out.push({
      periodStart,
      periodEnd: payDate,
      payDate,
      // I confini QUASI-cedolari restano esposti perché sono il DENOMINATORE del
      // rateo ACT/ACT-ICMA. Su un periodo regolare coincidono con periodStart/End;
      // su uno stub no, ed è lì che usare il periodo effettivo invece del
      // quasi-periodo raddoppia il rateo.
      quasiStart,
      quasiEnd: payDate,
      amountPer100: amountPer100.toDecimalPlaces(10, D.ROUND_HALF_EVEN).toFixed(),
      irregular,
    });
  }

  return out;
}

/**
 * Rateo cedolare PER 100 DI NOMINALE alla data di regolamento.
 *
 * @returns {{accruedPer100: string, periodStart: string|null, periodEnd: string|null, days: number}}
 */
function accruedInterest(bond: InstrumentLike, settleDate: DateString) {
  const settle = cal.normalizeDate(settleDate);
  const empty = { accruedPer100: "0", periodStart: null, periodEnd: null, days: 0 };
  if (!settle) return empty;

  const frequency = Number(bond.couponFrequency);
  if (!frequency) return empty; // zero coupon: nessun rateo

  const schedule = (bond.schedule as CouponPeriod[] | undefined) || couponSchedule(bond);
  if (!schedule.length) return empty;

  // Il periodo che CONTIENE settleDate: [periodStart, payDate). Estremo destro
  // ESCLUSO, così nel giorno di stacco il rateo è esattamente 0 — la cedola è
  // stata staccata, non è più maturanda.
  const period = schedule.find(
    (p) => cal.cmp(p.periodStart, settle) <= 0 && cal.cmp(settle, p.payDate) < 0
  );
  if (!period) return empty; // fuori dalla vita del titolo

  const dayCount = bond.dayCount || "ACT/ACT-ICMA";
  // Denominatore = QUASI-periodo (per un periodo regolare è il periodo stesso).
  // Su uno stub corto, usare il periodo effettivo raddoppierebbe il rateo.
  const frac = dayCountFraction(
    dayCount,
    period.periodStart,
    settle,
    period.quasiStart || period.periodStart,
    period.quasiEnd || period.periodEnd,
    frequency
  );

  // Per ACT/ACT-ICMA la frazione è già "quota d'anno", quindi rate*100*frac
  // ricostruisce couponPer100 × (giorni/giorniPeriodo).
  const accrued = d(bond.couponRate, 0).times(HUNDRED).times(frac);

  return {
    accruedPer100: accrued.toDecimalPlaces(10, D.ROUND_HALF_EVEN).toFixed(),
    periodStart: period.periodStart,
    periodEnd: period.periodEnd,
    days: cal.daysBetween(period.periodStart, settle),
  };
}

/**
 * Eventi futuri per il calendario: una voce per cedola più il rimborso a
 * scadenza. `fromDate` filtra le cedole già passate.
 */
function projectedEvents(bond: InstrumentLike, fromDate: DateString | null = null) {
  const from = cal.normalizeDate(fromDate);
  const maturity = cal.normalizeDate(bond.maturityDate);
  const events = [];

  for (const p of couponSchedule(bond)) {
    if (from && cal.cmp(p.payDate, from) < 0) continue;
    events.push({
      kind: "COUPON",
      payDate: p.payDate,
      exDate: null,
      amountPerUnit: p.amountPer100, // per 100 di nominale (docs/decisions.md §9)
      irregular: p.irregular,
    });
  }

  if (maturity && (!from || cal.cmp(maturity, from) >= 0)) {
    events.push({
      kind: "REDEMPTION",
      payDate: maturity,
      exDate: null,
      amountPerUnit: "100", // rimborso al 100% del nominale
      irregular: false,
    });
  }

  return events;
}

/**
 * Rendimento corrente = cedola annua / prezzo. YTM, duration e convexity sono
 * rinviati fuori dalla v1: richiedono un solver.
 * @returns {string|null} frazione (0.0345 = 3,45%)
 */
function currentYield(bond: InstrumentLike, cleanPrice: Numeric) {
  const p = d(cleanPrice);
  if (p.lte(0)) return null;
  const annualPer100 = d(bond.couponRate, 0).times(HUNDRED);
  if (annualPer100.isZero()) return null;
  const y = safeDiv(annualPer100, p);
  return y === null ? null : y.toDecimalPlaces(8, D.ROUND_HALF_EVEN).toFixed();
}

/** Nominale = quantità × valore facciale. */
function nominalOf(quantity: Numeric, faceValue: Numeric): Decimal {
  return d(quantity).times(d(faceValue, 1));
}

/**
 * Valore di mercato di una posizione obbligazionaria, dal corso SECCO in % del
 * nominale: nominale × prezzo/100.
 */
function bondValue(quantity: Numeric, faceValue: Numeric, pricePct: Numeric): Decimal {
  return nominalOf(quantity, faceValue).times(d(pricePct)).div(HUNDRED);
}

export { DAY_COUNTS, monthsPerPeriod, days30E360, dayCountFraction, couponSchedule, accruedInterest, projectedEvents, currentYield, nominalOf, bondValue };
