// Serializzazione delle risposte calcolate.
//
// Confine di arrotondamento: i valori Decimal restano interi lungo tutta la
// catena di calcolo e diventano STRINGHE arrotondate solo qui, all'uscita
// (docs/decisions.md §1).
import { money, qty, price as fmtPrice, fx as fmtFx, d, D } from "../domain/money";

/** Frazione (0.1706) → stringa a 4 decimali. Le percentuali le fa la UI. */
const pct = (v) =>
  v === null || v === undefined ? null : d(v).toDecimalPlaces(4, D.ROUND_HALF_EVEN).toFixed(4);

const m = (v) => (v === null || v === undefined ? null : money(v));
const q = (v) => (v === null || v === undefined ? null : qty(v));
const p = (v) => (v === null || v === undefined ? null : fmtPrice(v));
const f = (v) => (v === null || v === undefined ? null : fmtFx(v));

/** Riga di posizione per GET /api/portfolio/positions. */
function position(row) {
  const inst = row.instrument || {};
  return {
    instrument: {
      id: inst.id ?? row.instrumentId,
      name: inst.name ?? null,
      ticker: inst.ticker ?? null,
      isin: inst.isin ?? null,
      assetClass: inst.assetClass ?? null,
      currency: row.currency,
      quoteConvention: inst.quoteConvention ?? "PRICE",
      faceValue: m(inst.faceValue),
      issuer: inst.issuer ?? null,
      priceSource: inst.priceSource ?? null,
    },
    quantity: q(row.quantity),
    // Per i bond il nominale è ciò che mostra il broker: esporlo evita che
    // l'utente debba moltiplicare a mente.
    nominal:
      inst.quoteConvention === "PCT_OF_NOMINAL"
        ? m(d(row.quantity).times(d(inst.faceValue, 1)))
        : null,
    avgCost: p(row.avgCost),
    costBasis: m(row.costBasis),
    price: p(row.price),
    priceDate: row.priceDate,
    priceSource: row.priceSource,
    marketValue: m(row.marketValueLocal),
    marketValueBase: m(row.marketValueBase),
    weight: pct(row.weight),
    unrealizedPnl: m(row.unrealizedPnl),
    unrealizedPnlPct: pct(row.unrealizedPnlPct),
    // Realizzato, redditi e latente restano TRE VOCI SEPARATE: non vengono mai
    // sommate in un unico "profitto" (docs/decisions.md §3).
    realizedPnl: m(row.realizedPnl),
    incomeGross: m(row.incomeGross),
    taxWithheld: m(row.taxWithheld),
    incomeNet: m(row.incomeNet),
    accruedInterest: m(row.accruedInterest),
    feesTotal: m(row.feesTotal),
    dayChange: m(row.dayChange),
    fxRate: f(row.fxRate),
    priced: row.priced,
    stale: !!row.stale,
    warnings: row.warnings || [],
  };
}

/** Totali per GET /api/portfolio/summary. */
function summaryTotals(t) {
  return {
    marketValue: m(t.marketValue),
    totalValue: m(t.totalValue),
    costBasis: m(t.costBasis),
    unrealizedPnl: m(t.unrealizedPnl),
    unrealizedPnlPct: pct(t.unrealizedPnlPct),
    realizedPnl: m(t.realizedPnl),
    incomeGross: m(t.incomeGross),
    taxWithheld: m(t.taxWithheld),
    incomeNet: m(t.incomeNet),
    accruedInterest: m(t.accruedInterest),
    feesTotal: m(t.feesTotal),
    dayChange: m(t.dayChange),
    dayChangePct: pct(t.dayChangePct),
  };
}

const seriesPoint = (pt) => ({
  date: pt.date,
  value: m(pt.value),
  cost: m(pt.cost),
  netInvested: m(pt.netInvested),
  pnl: m(pt.pnl),
  accrued: m(pt.accrued),
  // `partial` guida il rendering tratteggiato: un segmento con dati incompleti non
  // deve somigliare a un crollo.
  partial: !!pt.partial,
});

const allocationGroup = (g) => ({
  key: String(g.key),
  label: g.label,
  marketValue: m(g.marketValue),
  weight: pct(g.weight),
});

export { pct, m, q, p, f, position, summaryTotals, seriesPoint, allocationGroup };
