// Serie temporale del valore di portafoglio.
//
// Due insidie vivono qui, entrambe documentate in docs/decisions.md:
//   §4 doppio conteggio degli split — si usa la serie di quantità AGGIUSTATA
//      contro il `close` di Yahoo, che è già retro-aggiustato
//   §5 prezzo mancante — forward-fill e flag `partial`, MAI uno zero
const { D, d, ZERO, toBase, isBlank } = require("./money");
const cal = require("./calendar");
const positions = require("./positions");
const bondsMod = require("./bonds");

/**
 * Costruisce la serie del valore di portafoglio.
 *
 * @param {object} args
 * @param {string[]} args.dates griglia ascendente
 * @param {Map<number, Array<object>>} args.txsByInstrument transazioni per strumento
 * @param {Map<number, object>} args.instruments metadati (currency, faceValue, quoteConvention)
 * @param {Map<number, Array<{date, close}>>} args.pricesByInstrument righe SPARSE ascendenti
 * @param {Map<string, Array<{date, rate}>>} args.fxByCcy righe SPARSE, tassi EUR→ccy
 * @param {Array<object>} [args.flows] flussi esterni (per netInvested)
 * @param {string} [args.baseCcy='EUR']
 * @param {boolean} [args.includeAccrued=false] somma il rateo obbligazionario al valore
 * @returns {{points: Array, warnings: Array}}
 */
function valueSeries(args) {
  const dates = args.dates || [];
  const instruments = args.instruments || new Map();
  const txsByInstrument = args.txsByInstrument || new Map();
  const pricesByInstrument = args.pricesByInstrument || new Map();
  const fxByCcy = args.fxByCcy || new Map();
  const baseCcy = (args.baseCcy || "EUR").toUpperCase();
  const includeAccrued = !!args.includeAccrued;

  const warnings = [];
  if (dates.length === 0) return { points: [], warnings };

  // Lookup FX forward-fill, uno per valuta.
  const fxLookups = new Map();
  for (const [ccy, rows] of fxByCcy) {
    fxLookups.set(ccy.toUpperCase(), cal.forwardFillLookup(rows, { valueKey: "rate" }));
  }
  const fxAt = (ccy, date) => {
    const c = (ccy || baseCcy).toUpperCase();
    if (c === baseCcy) return { value: "1", filled: false };
    const lk = fxLookups.get(c);
    return lk ? lk(date) : { value: null, filled: false };
  };

  // Accumulatori per data.
  const totals = dates.map(() => ({ value: ZERO, cost: ZERO, accrued: ZERO }));
  const partialFlags = dates.map(() => false);
  const missingByInstrument = new Map();

  for (const [instrumentId, txs] of txsByInstrument) {
    const inst = instruments.get(Number(instrumentId)) || {};
    const ccy = (inst.currency || baseCcy).toUpperCase();

    // QUANTITÀ AGGIUSTATA PER GLI SPLIT: è questo che evita il doppio conteggio
    // contro il `close` retro-aggiustato di Yahoo (§4).
    const qtySeries = positions.splitAdjustedQuantitySeries(txs, dates);
    const costs = positions.costSeries(txs, dates, {
      baseCcy,
      instruments,
      fxLookup: (c, date) => fxAt(c, date).value,
    });

    const priceAt = cal.forwardFillLookup(pricesByInstrument.get(Number(instrumentId)) || [], {
      valueKey: "close",
    });

    // Scadenzario cedolare, calcolato UNA VOLTA per strumento.
    //
    // Il rateo si calcola SEMPRE e si riporta a parte (campo `accrued`): così la UI
    // può mostrare "di cui rateo" senza una seconda richiesta. `includeAccrued`
    // decide soltanto se sommarlo al valore — corso tel quel invece che secco.
    let schedule = null;
    if (inst.assetClass === "BOND" && inst.couponFrequency) {
      try {
        schedule = bondsMod.couponSchedule(inst);
      } catch {
        schedule = null;
      }
    }

    for (let i = 0; i < dates.length; i++) {
      const date = dates[i];
      const qty = qtySeries[i].quantity;

      totals[i].cost = totals[i].cost.plus(costs[i].cost);

      // Nessuna posizione a quella data: niente da valorizzare, e soprattutto
      // niente da segnalare come dato mancante.
      if (qty.isZero()) continue;

      const p = priceAt(date);
      const fxr = fxAt(ccy, date);

      if (isBlank(p.value) || isBlank(fxr.value)) {
        // PREZZO (o cambio) MANCANTE. Contributo 0 al totale, ma il punto viene
        // marcato `partial`: uno zero silenzioso somiglia a un crollo del
        // portafoglio, non a un buco nei dati. È la peggior modalità di
        // fallimento dell'intera app (§5).
        partialFlags[i] = true;
        const key = `${instrumentId}:${isBlank(p.value) ? "price" : "fx"}`;
        if (!missingByInstrument.has(key)) {
          missingByInstrument.set(key, {
            code: isBlank(p.value) ? "price_missing" : "fx_missing",
            instrumentId: Number(instrumentId),
            instrumentName: inst.name || null,
            currency: ccy,
            from: date,
            to: date,
            days: 0,
          });
        }
        const w = missingByInstrument.get(key);
        w.to = date;
        w.days += 1;
        continue;
      }

      const local = positions.positionValue(qty, p.value, inst);
      totals[i].value = totals[i].value.plus(toBase(local, fxr.value));

      if (schedule) {
        const acc = bondsMod.accruedInterest({ ...inst, schedule }, date);
        if (acc.accruedPer100 !== "0") {
          // Rateo per 100 di nominale → importo: nominale × rateo/100.
          const nominal = qty.times(d(inst.faceValue, 1));
          const accruedLocal = nominal.times(d(acc.accruedPer100)).div(100);
          totals[i].accrued = totals[i].accrued.plus(toBase(accruedLocal, fxr.value));
        }
      }
    }
  }

  for (const w of missingByInstrument.values()) {
    warnings.push({
      ...w,
      message:
        w.code === "price_missing"
          ? `nessun prezzo per lo strumento ${w.instrumentId} in ${w.days} giorni (dal ${w.from} al ${w.to}): la serie è incompleta`
          : `nessun cambio ${baseCcy}/${w.currency} in ${w.days} giorni (dal ${w.from} al ${w.to}): la serie è incompleta`,
    });
  }

  // Investito netto: seconda linea del grafico e input del TWR.
  const netInvested = args.flows
    ? require("./returns").netInvestedSeries(args.flows, dates)
    : dates.map((date) => ({ date, netInvested: ZERO }));

  const points = dates.map((date, i) => {
    const value = includeAccrued ? totals[i].value.plus(totals[i].accrued) : totals[i].value;
    const ni = netInvested[i].netInvested;
    return {
      date,
      value,
      cost: totals[i].cost,
      accrued: totals[i].accrued,
      netInvested: ni,
      // P&L rispetto all'investito netto: è la lettura che l'utente fa del grafico
      // ("quanto ho guadagnato"), non rispetto al solo carico.
      pnl: value.minus(ni),
      partial: partialFlags[i],
    };
  });

  return { points, warnings };
}

/**
 * Valorizza le posizioni a una data, con prezzi e cambi puntuali.
 *
 * @returns {{rows: Array, totals: object, warnings: Array}}
 */
function valuePositions(args) {
  const asOf = cal.normalizeDate(args.asOf);
  const built = args.built; // output di buildPositions
  const instruments = args.instruments || new Map();
  const quotes = args.quotes || new Map(); // instrumentId → {price, previousClose, currency, asOf}
  const fxRates = args.fxRates || new Map(); // ccy → rate EUR→ccy
  const baseCcy = (args.baseCcy || "EUR").toUpperCase();
  const includeAccrued = !!args.includeAccrued;

  const warnings = [...(built.warnings || [])];
  const rows = [];

  for (const [instrumentId, p] of built.positions) {
    const inst = instruments.get(Number(instrumentId)) || {};
    const ccy = (inst.currency || baseCcy).toUpperCase();
    const q = quotes.get(Number(instrumentId)) || {};
    const fxRate = ccy === baseCcy ? "1" : fxRates.get(ccy);

    if (ccy !== baseCcy && isBlank(fxRate)) {
      warnings.push({
        code: "fx_missing",
        instrumentId: Number(instrumentId),
        currency: ccy,
        message: `nessun cambio ${baseCcy}/${ccy}: la posizione ${inst.name || instrumentId} non è convertita`,
      });
    }

    // Una posizione chiusa senza prezzo non è un problema: non c'è niente da
    // valorizzare, e segnalarla genererebbe solo rumore.
    if (isBlank(q.price) && !p.quantity.isZero()) {
      warnings.push({
        code: "price_missing",
        instrumentId: Number(instrumentId),
        instrumentName: inst.name || null,
        message: `nessuna quotazione per ${inst.name || instrumentId}: valore di mercato non disponibile`,
      });
    }

    const valued = positions.valuePosition(p, inst, q.price, fxRate ?? "1", {
      previousClose: q.previousClose,
    });

    // Rateo corrente sulla posizione obbligazionaria.
    let accrued = ZERO;
    if (inst.assetClass === "BOND" && inst.couponFrequency && !p.quantity.isZero()) {
      try {
        const acc = bondsMod.accruedInterest(inst, asOf);
        const nominal = p.quantity.times(d(inst.faceValue, 1));
        accrued = toBase(nominal.times(d(acc.accruedPer100)).div(100), fxRate ?? "1");
      } catch {
        accrued = ZERO;
      }
    }

    rows.push({
      ...valued,
      instrument: inst,
      currency: ccy,
      priceDate: q.asOf || q.priceDate || null,
      priceSource: q.source || null,
      accruedInterest: accrued,
      stale: !!q.stale,
    });
  }

  // Totali: solo le posizioni valorizzate contribuiscono al valore di mercato.
  const marketValue = rows.reduce(
    (acc, r) => (r.marketValueBase === null ? acc : acc.plus(r.marketValueBase)),
    ZERO
  );
  const accruedTotal = rows.reduce((acc, r) => acc.plus(r.accruedInterest), ZERO);
  const costBasis = rows.reduce((acc, r) => acc.plus(r.costBasis), ZERO);
  const realizedPnl = rows.reduce((acc, r) => acc.plus(r.realizedPnl), ZERO);
  const incomeGross = rows.reduce((acc, r) => acc.plus(r.incomeGross), ZERO);
  const taxWithheld = rows.reduce((acc, r) => acc.plus(r.taxWithheld), ZERO);
  const feesTotal = rows.reduce((acc, r) => acc.plus(r.feesTotal), ZERO);
  const dayChange = rows.reduce(
    (acc, r) => (r.dayChange === null ? acc : acc.plus(r.dayChange)),
    ZERO
  );

  const totalValue = includeAccrued ? marketValue.plus(accruedTotal) : marketValue;
  const unrealizedPnl = marketValue.minus(costBasis);

  // I pesi si calcolano sul valore di mercato: con totale zero sono tutti zero,
  // non NaN.
  for (const r of rows) {
    r.weight =
      marketValue.isZero() || r.marketValueBase === null
        ? ZERO
        : r.marketValueBase.div(marketValue);
  }

  return {
    rows,
    totals: {
      marketValue,
      totalValue,
      accruedInterest: accruedTotal,
      costBasis,
      unrealizedPnl,
      unrealizedPnlPct: costBasis.isZero() ? null : unrealizedPnl.div(costBasis),
      realizedPnl,
      incomeGross,
      taxWithheld,
      incomeNet: incomeGross.minus(taxWithheld),
      feesTotal,
      dayChange,
      dayChangePct: marketValue.minus(dayChange).isZero()
        ? null
        : dayChange.div(marketValue.minus(dayChange)),
    },
    warnings,
  };
}

/** Raggruppa le righe valorizzate per una chiave, con pesi. */
function allocate(rows, keyFn, labelFn) {
  const groups = new Map();
  let total = ZERO;

  for (const r of rows) {
    if (r.marketValueBase === null) continue;
    const key = keyFn(r) ?? "—";
    if (!groups.has(key)) {
      groups.set(key, { key, label: labelFn ? labelFn(r) : String(key), marketValue: ZERO });
    }
    groups.get(key).marketValue = groups.get(key).marketValue.plus(r.marketValueBase);
    total = total.plus(r.marketValueBase);
  }

  return [...groups.values()]
    .map((g) => ({
      ...g,
      weight: total.isZero() ? ZERO : g.marketValue.div(total),
    }))
    .sort((a, b) => b.marketValue.comparedTo(a.marketValue));
}

module.exports = { valueSeries, valuePositions, allocate };
