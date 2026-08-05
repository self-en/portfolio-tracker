// Ledger → posizioni. Costo medio ponderato, P&L realizzato, redditi, e la serie
// di quantità aggiustata per gli split.
//
// È il file a più alto rischio dell'applicazione, e per questo è puro: nessun I/O,
// il tempo è un parametro, e la sola dipendenza è decimal.js.
import { D, d, ZERO, ONE, HUNDRED, toBase, isBlank } from "./money";
import * as cal from "./calendar";
import type Decimal from "decimal.js";
import type { Numeric } from "./money";
import type { DateString } from "../types";
import type {
  DomainWarning,
  FxLookup,
  InstrumentLike,
  NormalizedTx,
  Position,
  TxLike,
} from "./types";

/** Opzioni comuni a buildPositions/costSeries: da dove vengono cambio e strumenti. */
export interface BuildPositionsOptions {
  baseCcy?: string;
  instruments?: Map<number, InstrumentLike>;
  fxLookup?: FxLookup;
  /** Seam per FIFO in v1.1: oggi esiste solo il costo medio. */
  method?: "AVERAGE";
  asOf?: DateString;
}

/** Tipi che muovono la quantità in carico. */
const POSITION_TYPES = new Set(["BUY", "SELL", "SPLIT", "RETURN_OF_CAPITAL"]);
/** Tipi che sono flussi esterni ai fini di TWR/XIRR (la cassa pura è esclusa). */
const FLOW_TYPES = new Set([
  "BUY",
  "SELL",
  "DIVIDEND",
  "COUPON",
  "INTEREST",
  "FEE",
  "TAX",
  "RETURN_OF_CAPITAL",
]);

/**
 * Ordinamento deterministico: (trade_date, id). L'`id` come tie-break non è un
 * dettaglio — due operazioni in pari data sullo stesso titolo danno costi medi
 * diversi a seconda dell'ordine, e senza tie-break il risultato dipenderebbe
 * dall'ordine che il database ha scelto di restituire.
 */
function sortLedger<T extends TxLike | NormalizedTx>(txs: readonly T[]): T[] {
  return [...txs].sort((a, b) => {
    const c = cal.cmp(
      cal.normalizeDate((a as TxLike).tradeDate ?? (a as TxLike).trade_date) ?? "",
      cal.normalizeDate((b as TxLike).tradeDate ?? (b as TxLike).trade_date) ?? ""
    );
    if (c !== 0) return c;
    return Number(a.id ?? 0) - Number(b.id ?? 0);
  });
}

/** Vista normalizzata di una riga di transazione, indipendente dalla forma del repo. */
function normalizeTx(tx: TxLike): NormalizedTx {
  return {
    id: Number(tx.id ?? 0),
    portfolioId: tx.portfolioId ?? tx.portfolio_id ?? null,
    instrumentId: tx.instrumentId ?? tx.instrument_id ?? null,
    type: tx.type,
    tradeDate: cal.normalizeDate(tx.tradeDate ?? tx.trade_date),
    quantity: tx.quantity ?? null,
    price: tx.price ?? null,
    grossAmount: tx.grossAmount ?? tx.gross_amount ?? null,
    fees: tx.fees ?? null,
    taxes: tx.taxes ?? null,
    accruedInterest: tx.accruedInterest ?? tx.accrued_interest ?? null,
    netAmount: tx.netAmount ?? tx.net_amount ?? null,
    tradeCcy: tx.tradeCcy ?? tx.trade_ccy ?? null,
    fxRate: tx.fxRate ?? tx.fx_rate ?? null,
    splitRatio: tx.splitRatio ?? tx.split_ratio ?? null,
  };
}

/**
 * Importo lordo di una compravendita, nella valuta della transazione.
 *
 * Per le obbligazioni quotate in % del nominale: nominale × prezzo/100, dove
 * nominale = quantità × valore facciale. Passare per la quantità come se fosse un
 * numero di azioni sbaglierebbe di un fattore 1000.
 */
function tradeGross(
  tx: Pick<TxLike, "quantity" | "price"> | NormalizedTx,
  instrument?: InstrumentLike | null
): Decimal {
  const q = d(tx.quantity);
  const p = d(tx.price);
  if (instrument && instrument.quoteConvention === "PCT_OF_NOMINAL") {
    return q.times(d(instrument.faceValue, 1)).times(p).div(HUNDRED);
  }
  return q.times(p);
}

/** Valore di mercato di una quantità a un dato prezzo, nella valuta dello strumento. */
function positionValue(quantity: Numeric, price: Numeric, instrument?: InstrumentLike | null): Decimal {
  const q = d(quantity);
  const p = d(price);
  if (instrument && instrument.quoteConvention === "PCT_OF_NOMINAL") {
    return q.times(d(instrument.faceValue, 1)).times(p).div(HUNDRED);
  }
  return q.times(p);
}

/**
 * Risolve il tasso EUR→ccy per una transazione.
 * Ordine: tasso esplicito sulla transazione → lookup dalla cache → 1 se la valuta
 * è già la base. Se nulla di tutto questo, si segnala e si usa 1 marcando la
 * posizione: un tasso inventato in silenzio è peggio di un warning.
 */
function resolveFx(
  tx: NormalizedTx,
  baseCcy: string,
  fxLookup: FxLookup | undefined,
  warnings: DomainWarning[]
): Decimal {
  const ccy = (tx.tradeCcy || baseCcy || "EUR").toUpperCase();
  if (ccy === baseCcy) return ONE;
  if (!isBlank(tx.fxRate)) return d(tx.fxRate);
  if (typeof fxLookup === "function") {
    const r = fxLookup(ccy, tx.tradeDate);
    if (!isBlank(r)) return d(r);
  }
  warnings.push({
    code: "fx_missing",
    message: `tasso di cambio ${baseCcy}/${ccy} non disponibile al ${tx.tradeDate}: importi non convertiti`,
    instrumentId: tx.instrumentId,
    txId: tx.id,
    currency: ccy,
    date: tx.tradeDate,
  });
  return ONE;
}

function emptyPosition(instrumentId: number): Position {
  return {
    instrumentId,
    quantity: ZERO,
    costBasis: ZERO, // in valuta base, commissioni di acquisto incluse
    realizedPnl: ZERO,
    incomeGross: ZERO,
    taxWithheld: ZERO,
    accruedPaid: ZERO, // rateo pagato in acquisto (voce di reddito NEGATIVA)
    accruedReceived: ZERO, // rateo incassato in vendita
    feesTotal: ZERO, // commissioni capitalizzate + standalone, per trasparenza
    taxesTotal: ZERO,
    buyQuantity: ZERO,
    sellQuantity: ZERO,
    firstTradeDate: null,
    lastTradeDate: null,
    txCount: 0,
    warnings: [],
  };
}

/**
 * Costruisce le posizioni dal ledger, in una sola passata.
 *
 * @param {Array<object>} txs righe di transazione (numerici come stringa)
 * @param {object} opts
 * @param {string} [opts.baseCcy='EUR']
 * @param {Map<number,object>} [opts.instruments] per faceValue/quoteConvention
 * @param {(ccy: string, date: string) => string|null} [opts.fxLookup]
 * @param {'AVERAGE'} [opts.method='AVERAGE'] seam per FIFO in v1.1
 * @param {string} [opts.asOf] ignora le transazioni successive a questa data
 * @returns {{positions: Map<number,object>, cash: Object, warnings: Array, flows: Array}}
 */
function buildPositions(txs: readonly TxLike[], opts: BuildPositionsOptions = {}) {
  const baseCcy = (opts.baseCcy || "EUR").toUpperCase();
  const instruments = opts.instruments || new Map();
  const fxLookup = opts.fxLookup;
  const method = opts.method || "AVERAGE";
  const asOf = opts.asOf ? cal.normalizeDate(opts.asOf) : null;

  if (method !== "AVERAGE") {
    // Il seam esiste, la seconda strategia no: dirlo forte invece di calcolare
    // silenziosamente col metodo sbagliato.
    throw new Error(`metodo di costo non supportato: ${method} (v1 implementa solo AVERAGE)`);
  }

  const warnings = [];
  const positions = new Map();
  const cash: Record<string, Decimal> = {}; // saldo per valuta, ricavato gratis dal ledger
  const flows = []; // {date, amountBase} flussi esterni per TWR/XIRR

  const ordered = sortLedger(txs.map(normalizeTx)).filter(
    (tx) => !asOf || cal.cmp(tx.tradeDate ?? "", asOf) <= 0
  );

  for (const tx of ordered) {
    const rate = resolveFx(tx, baseCcy, fxLookup, warnings);
    const ccy = (tx.tradeCcy || baseCcy).toUpperCase();
    const inst = tx.instrumentId != null ? instruments.get(Number(tx.instrumentId)) : null;

    // Ledger di cassa: vale per OGNI tipo. Non è un'asset class richiesta, ma è un
    // controllo di sanità gratuito sull'inserimento dati.
    cash[ccy] = d(cash[ccy]).plus(d(tx.netAmount));

    // Flussi esterni in valuta base, per TWR e XIRR. Il segno di net_amount è già
    // quello del flusso di cassa dell'investitore (BUY negativo, SELL positivo),
    // quindi non c'è nessuna conversione di segno da sbagliare.
    if (FLOW_TYPES.has(tx.type)) {
      flows.push({ date: tx.tradeDate, amountBase: toBase(d(tx.netAmount), rate), type: tx.type });
    }

    if (tx.instrumentId == null) continue; // DEPOSIT/WITHDRAWAL: solo cassa

    const key = Number(tx.instrumentId);
    if (!positions.has(key)) positions.set(key, emptyPosition(key));
    const p = positions.get(key);

    p.txCount += 1;
    if (!p.firstTradeDate) p.firstTradeDate = tx.tradeDate;
    p.lastTradeDate = tx.tradeDate;

    const fees = toBase(d(tx.fees), rate);
    const taxes = toBase(d(tx.taxes), rate);
    const accrued = toBase(d(tx.accruedInterest), rate);

    switch (tx.type) {
      case "BUY": {
        const q = d(tx.quantity);
        const gross = toBase(tradeGross(tx, inst), rate);
        p.quantity = p.quantity.plus(q);
        // Le commissioni di acquisto AUMENTANO il carico: prassi italiana.
        // Il rateo cedolare NO: è una voce di reddito negativa, recuperata alla
        // cedola successiva (docs/decisions.md §3).
        p.costBasis = p.costBasis.plus(gross).plus(fees).plus(taxes);
        p.accruedPaid = p.accruedPaid.plus(accrued);
        p.feesTotal = p.feesTotal.plus(fees);
        p.taxesTotal = p.taxesTotal.plus(taxes);
        p.buyQuantity = p.buyQuantity.plus(q);
        break;
      }

      case "SELL": {
        let q = d(tx.quantity);
        // GUARDIA SULL'OVERSELL: si clampa, si avvisa, si continua. Mai quantità
        // negative silenziose — una posizione negativa si propaga in tutti i
        // calcoli a valle e non somiglia a un errore di inserimento.
        if (q.gt(p.quantity)) {
          const w = {
            code: "oversell",
            message: `vendita di ${q.toFixed()} superiore alla quantità in carico ${p.quantity.toFixed()}: quantità ridotta`,
            instrumentId: key,
            txId: tx.id,
            date: tx.tradeDate,
            requested: q.toFixed(),
            available: p.quantity.toFixed(),
          };
          warnings.push(w);
          p.warnings.push(w);
          q = p.quantity;
        }

        const gross = toBase(tradeGross(tx, inst), rate);
        // I proventi restano quelli effettivamente incassati (cassa reale), anche
        // se la quantità è stata clampata.
        const proceeds = gross.minus(fees).minus(taxes);
        // Costo medio ponderato: si rimuove la quota media del carico.
        const avg = p.quantity.isZero() ? ZERO : p.costBasis.div(p.quantity);
        const costRemoved = avg.times(q);

        p.realizedPnl = p.realizedPnl.plus(proceeds).minus(costRemoved);
        p.quantity = p.quantity.minus(q);
        p.costBasis = p.costBasis.minus(costRemoved);
        // Residui di arrotondamento: chiusa la posizione, il carico è zero.
        if (p.quantity.isZero()) p.costBasis = ZERO;
        p.accruedReceived = p.accruedReceived.plus(accrued);
        p.feesTotal = p.feesTotal.plus(fees);
        p.taxesTotal = p.taxesTotal.plus(taxes);
        p.sellQuantity = p.sellQuantity.plus(q);
        break;
      }

      case "SPLIT": {
        // La quantità si moltiplica, il COSTO resta invariato: il costo medio
        // unitario si divide implicitamente per il ratio. Il ledger non viene mai
        // riscritto (docs/decisions.md §4).
        const ratio = d(tx.splitRatio, 1);
        if (ratio.lte(0)) {
          const w = {
            code: "invalid_split",
            message: `ratio di split non valido (${tx.splitRatio}): ignorato`,
            instrumentId: key,
            txId: tx.id,
          };
          warnings.push(w);
          p.warnings.push(w);
          break;
        }
        p.quantity = p.quantity.times(ratio);
        break;
      }

      case "DIVIDEND":
      case "COUPON":
      case "INTEREST": {
        // Lordo + ritenuta separata (requisito dell'utente): la dashboard può
        // mostrare rendimento lordo, incidenza fiscale e netto incassato.
        // Quantità e carico restano intatti.
        const gross = toBase(d(tx.grossAmount ?? tx.netAmount), rate);
        p.incomeGross = p.incomeGross.plus(gross);
        p.taxWithheld = p.taxWithheld.plus(taxes);
        break;
      }

      case "RETURN_OF_CAPITAL": {
        // Rimborso di capitale: riduce il carico. L'eccedenza sotto zero diventa
        // plusvalenza realizzata, perché il carico non può essere negativo.
        const amount = toBase(d(tx.netAmount), rate);
        p.costBasis = p.costBasis.minus(amount);
        if (p.costBasis.lt(0)) {
          p.realizedPnl = p.realizedPnl.plus(p.costBasis.negated());
          p.costBasis = ZERO;
        }
        break;
      }

      case "FEE":
      case "TAX": {
        // Standalone: NON capitalizzate nel carico (docs/decisions.md §3).
        // net_amount è negativo, quindi si prende il valore assoluto.
        const amount = toBase(d(tx.netAmount), rate).negated();
        if (tx.type === "FEE") p.feesTotal = p.feesTotal.plus(amount);
        else p.taxesTotal = p.taxesTotal.plus(amount);
        break;
      }

      default:
        warnings.push({
          code: "unknown_type",
          message: `tipo di transazione non gestito: ${tx.type}`,
          instrumentId: key,
          txId: tx.id,
        });
    }
  }

  return { positions, cash, warnings, flows, orderedTxs: ordered };
}

/**
 * Fattore di aggiustamento per gli split di ciascuna transazione.
 *
 * LEGGERE docs/decisions.md §4 PRIMA DI TOCCARE QUESTA FUNZIONE. La serie `close`
 * di Yahoo è già retro-aggiustata per gli split (verificato: il close di AAPL del
 * 2020-06-01 è 80,46 contro ~322 realmente scambiati). Se si moltiplicassero anche
 * le quantità storiche, la valorizzazione conterebbe DUE VOLTE lo split.
 *
 * qtyAdj(d) = qtyComeTransata(d) × Π(ratio di ogni SPLIT con trade_date > d)
 */
function splitFactors(txs: readonly TxLike[]) {
  const ordered = sortLedger(txs.map(normalizeTx));
  const splits = ordered
    .filter((t) => t.type === "SPLIT")
    .map((t) => ({ date: t.tradeDate, ratio: d(t.splitRatio, 1) }))
    .filter((s) => s.ratio.gt(0));

  let total = ONE;
  for (const s of splits) total = total.times(s.ratio);
  return { splits, total };
}

/**
 * Serie di quantità AGGIUSTATA PER GLI SPLIT, allineata a `dates`: le quantità
 * storiche sono riportate in termini di quote odierne, così da moltiplicarle per la
 * serie `close` (già aggiustata) senza contare due volte.
 *
 * Singola passata con puntatore mobile: O(giorni + transazioni), mai una
 * riscansione per giorno.
 *
 * @returns {Array<{date: string, quantity: Decimal, raw: Decimal}>}
 */
function splitAdjustedQuantitySeries(
  txs: readonly TxLike[],
  dates: readonly DateString[]
): Array<{ date: DateString; quantity: Decimal; raw: Decimal }> {
  const ordered = sortLedger(txs.map(normalizeTx));
  const { total } = splitFactors(txs);

  const out: Array<{ date: DateString; quantity: Decimal; raw: Decimal }> = [];
  let i = 0;
  let raw = ZERO; // quantità "come transata" a quella data
  let appliedSplitProduct = ONE; // prodotto degli split GIÀ avvenuti

  for (const day of dates) {
    while (i < ordered.length && cal.cmp(ordered[i].tradeDate ?? "", day) <= 0) {
      const tx = ordered[i];
      if (tx.type === "BUY") raw = raw.plus(d(tx.quantity));
      else if (tx.type === "SELL") {
        const q = d(tx.quantity);
        raw = q.gt(raw) ? ZERO : raw.minus(q); // stesso clamp di buildPositions
      } else if (tx.type === "SPLIT") {
        const ratio = d(tx.splitRatio, 1);
        if (ratio.gt(0)) {
          raw = raw.times(ratio);
          appliedSplitProduct = appliedSplitProduct.times(ratio);
        }
      }
      i++;
    }
    // Gli split ANCORA DA VENIRE sono quelli che riportano la quantità storica in
    // termini odierni.
    const remaining = total.div(appliedSplitProduct);
    out.push({ date: day, quantity: raw.times(remaining), raw });
  }

  return out;
}

/**
 * Serie del carico (costo medio) allineata a `dates`, in valuta base.
 * Stessa passata a puntatore mobile.
 */
function costSeries(
  txs: readonly TxLike[],
  dates: readonly DateString[],
  opts: BuildPositionsOptions = {}
): Array<{ date: DateString; cost: Decimal; quantity: Decimal }> {
  const baseCcy = (opts.baseCcy || "EUR").toUpperCase();
  const instruments = opts.instruments || new Map();
  const fxLookup = opts.fxLookup;
  const sink: DomainWarning[] = [];

  const ordered = sortLedger(txs.map(normalizeTx));
  const out: Array<{ date: DateString; cost: Decimal; quantity: Decimal }> = [];
  let i = 0;
  let qty = ZERO;
  let cost = ZERO;

  for (const day of dates) {
    while (i < ordered.length && cal.cmp(ordered[i].tradeDate ?? "", day) <= 0) {
      const tx = ordered[i];
      const rate = resolveFx(tx, baseCcy, fxLookup, sink);
      const inst = tx.instrumentId != null ? instruments.get(Number(tx.instrumentId)) : null;
      if (tx.type === "BUY") {
        qty = qty.plus(d(tx.quantity));
        cost = cost
          .plus(toBase(tradeGross(tx, inst), rate))
          .plus(toBase(d(tx.fees), rate))
          .plus(toBase(d(tx.taxes), rate));
      } else if (tx.type === "SELL") {
        let q = d(tx.quantity);
        if (q.gt(qty)) q = qty;
        const avg = qty.isZero() ? ZERO : cost.div(qty);
        qty = qty.minus(q);
        cost = cost.minus(avg.times(q));
        if (qty.isZero()) cost = ZERO;
      } else if (tx.type === "SPLIT") {
        const ratio = d(tx.splitRatio, 1);
        if (ratio.gt(0)) qty = qty.times(ratio);
      } else if (tx.type === "RETURN_OF_CAPITAL") {
        cost = cost.minus(toBase(d(tx.netAmount), rate));
        if (cost.lt(0)) cost = ZERO;
      }
      i++;
    }
    out.push({ date: day, cost, quantity: qty });
  }

  return out;
}

/**
 * Arricchisce una posizione con i valori di mercato. Puro: prezzo e cambio
 * arrivano come parametri.
 */
function valuePosition(
  position: Position,
  instrument: InstrumentLike | null | undefined,
  marketPrice: Numeric,
  fxRate: Numeric,
  opts: { partial?: boolean; previousClose?: Numeric } = {}
) {
  const rate = d(fxRate, 1);
  const price = isBlank(marketPrice) ? null : d(marketPrice);

  const marketValueLocal = price === null ? null : positionValue(position.quantity, price, instrument);
  const marketValueBase = marketValueLocal === null ? null : toBase(marketValueLocal, rate);

  const unrealized = marketValueBase === null ? null : marketValueBase.minus(position.costBasis);
  const unrealizedPct =
    marketValueBase === null || position.costBasis.isZero()
      ? null
      : unrealized!.div(position.costBasis);

  const avgCost = position.quantity.isZero() ? ZERO : position.costBasis.div(position.quantity);

  let dayChange = null;
  if (marketValueBase !== null && !isBlank(opts.previousClose)) {
    const prevLocal = positionValue(position.quantity, d(opts.previousClose), instrument);
    dayChange = marketValueBase.minus(toBase(prevLocal, rate));
  }

  return {
    ...position,
    avgCost,
    price,
    marketValueLocal,
    marketValueBase,
    unrealizedPnl: unrealized,
    unrealizedPnlPct: unrealizedPct,
    incomeNet: position.incomeGross.minus(position.taxWithheld),
    dayChange,
    fxRate: rate,
    // Nessun prezzo → si dichiara. Contributo zero al totale, ma marcato, perché
    // uno zero silenzioso somiglia a un crollo, non a un buco nei dati.
    priced: price !== null,
  };
}

export { POSITION_TYPES, FLOW_TYPES, sortLedger, normalizeTx, tradeGross, positionValue, buildPositions, splitFactors, splitAdjustedQuantitySeries, costSeries, valuePosition, emptyPosition };
