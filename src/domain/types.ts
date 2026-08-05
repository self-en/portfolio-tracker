// Tipi del dominio.
//
// Perche' gli input sono volutamente permissivi: queste funzioni accettano una
// riga sia in camelCase (dal repo) sia in snake_case (grezza dal database o da un
// import), ed e' una tolleranza deliberata - il dominio non deve sapere da dove
// arriva la riga. `?? tx.trade_date` nel codice non e' una svista, e' quel
// contratto. I tipi lo dichiarano invece di nasconderlo dietro `any`.
//
// Gli OUTPUT invece sono stretti: e' li' che i tipi servono davvero, perche' e'
// quello che il resto dell'app consuma.
import type Decimal from "decimal.js";
import type { Ccy, DateString, DecimalString } from "../types";

/** Un valore monetario in una qualunque delle forme che il dominio accetta. */
type Amount = Decimal | DecimalString | number | null;

/** Una riga di transazione accettata dal dominio, in una qualunque delle due forme. */
export interface TxLike {
  id?: number | string;
  portfolioId?: number | null;
  portfolio_id?: number | null;
  instrumentId?: number | null;
  instrument_id?: number | null;
  type: string;
  tradeDate?: DateString | null;
  trade_date?: DateString | null;
  settleDate?: DateString | null;
  settle_date?: DateString | null;
  quantity?: Amount;
  price?: Amount;
  grossAmount?: Amount;
  gross_amount?: Amount;
  fees?: Amount;
  taxes?: Amount;
  accruedInterest?: Amount;
  accrued_interest?: Amount;
  netAmount?: Amount;
  net_amount?: Amount;
  tradeCcy?: Ccy | null;
  trade_ccy?: Ccy | null;
  fxRate?: Amount;
  fx_rate?: Amount;
  splitRatio?: Amount;
  split_ratio?: Amount;
  /** Nominale indicato a mano su un'obbligazione (alternativo a quantity). */
  nominal?: Amount;
  /** Campi extra che il chiamante puo' portare (es. la riga arricchita di list()). */
  instrument?: unknown;
}

/** La transazione dopo normalizeTx(): una sola forma, camelCase. */
export interface NormalizedTx {
  id: number;
  portfolioId: number | null;
  instrumentId: number | null;
  type: string;
  tradeDate: DateString | null;
  quantity: Amount;
  price: Amount;
  grossAmount: Amount;
  fees: Amount;
  taxes: Amount;
  accruedInterest: Amount;
  netAmount: Amount;
  tradeCcy: Ccy | null;
  fxRate: Amount;
  splitRatio: Amount;
}

/** Quel poco che il dominio deve sapere di uno strumento per fare i conti. */
export interface InstrumentLike {
  id?: number;
  currency?: Ccy | null;
  quoteConvention?: string | null;
  faceValue?: DecimalString | number | null;
  couponRate?: DecimalString | number | null;
  couponFrequency?: number | null;
  firstCouponDate?: DateString | null;
  maturityDate?: DateString | null;
  dayCount?: string | null;
  assetClass?: string | null;
  /** Scadenzario gia' calcolato, quando il chiamante lo ha in mano. */
  schedule?: unknown;
  name?: string | null;
  ticker?: string | null;
  isin?: string | null;
  priceSource?: string | null;
}

/**
 * Un avvertimento che accompagna un risultato invece di interromperlo: un tasso
 * mancante produce un numero comunque, ma con `partial: true` e questo warning -
 * mai un errore silenzioso ne' un'eccezione.
 */
export interface DomainWarning {
  code: string;
  message?: string;
  instrumentId?: number | null;
  txId?: number | null;
  currency?: Ccy | null;
  date?: DateString | null;
  details?: unknown;
  instrumentName?: string | null;
  ticker?: string | null;
  priceDate?: DateString | null;
  /**
   * Solo per `oversell`: quanto si è provato a vendere e quanto c'era in carico.
   * Sono i due numeri che rendono il warning azionabile invece di solo allarmante,
   * e li leggono sia la UI sia i test — quindi vivono nel tipo, non solo
   * nell'oggetto che positions.ts costruisce.
   */
  requested?: DecimalString;
  available?: DecimalString;
  /**
   * L'INTERVALLO di un buco nella serie (`price_missing`/`fx_missing` prodotti da
   * `valueSeries`, che accorpa i giorni contigui in un warning solo). Non sono
   * decorativi: il messaggio stesso è costruito da questi tre campi.
   */
  from?: DateString;
  to?: DateString;
  days?: number;
}

/** Tasso EUR->ccy alla data, dalla cache. null/'' = non disponibile. */
export type FxLookup = (ccy: Ccy, date: DateString | null) => Amount | undefined;

/** Una posizione in costruzione: tutti gli importi sono Decimal, mai stringhe. */
export interface Position {
  instrumentId: number;
  quantity: Decimal;
  costBasis: Decimal;
  realizedPnl: Decimal;
  incomeGross: Decimal;
  taxWithheld: Decimal;
  accruedPaid: Decimal;
  accruedReceived: Decimal;
  feesTotal: Decimal;
  taxesTotal: Decimal;
  buyQuantity: Decimal;
  sellQuantity: Decimal;
  firstTradeDate: DateString | null;
  lastTradeDate: DateString | null;
  txCount: number;
  warnings: DomainWarning[];
}

/** Un flusso di cassa datato, in valuta base. Alimenta TWR e XIRR. */
export interface CashFlow {
  /** null quando la riga di origine non aveva una data valida: il consumatore filtra. */
  date: DateString | null;
  /**
   * Un flusso porta l'importo in valuta di transazione (`amount`) o gia' convertito
   * in base (`amountBase`): buildPositions produce il secondo, un import il primo, e
   * i consumatori leggono `amountBase ?? amount`. Uno dei due c'e' sempre.
   */
  amount?: Decimal | DecimalString | number;
  /** Importo gia' convertito in valuta base, quando il produttore lo conosce. */
  amountBase?: Decimal | DecimalString | number | null;
  /** BUY/SELL/DIVIDEND/... - decide se il flusso e' capitale (vedi CAPITAL_TYPES). */
  type?: string;
  [key: string]: unknown;
}

/** Un punto di una serie temporale: valore alla data (null = non disponibile). */
export interface SeriesPoint {
  date: DateString;
  /** Valore in valuta base, quando il produttore lo espone con questo nome. */
  valueBase?: Decimal | DecimalString | number | null;
  value: Decimal | DecimalString | number | null;
  /** true quando il punto e' stato calcolato con dati incompleti. */
  partial?: boolean;
  netInvested?: Decimal | DecimalString | number | null;
  // I tre campi che `valueSeries` mette su OGNI punto che produce. Sono opzionali
  // perche' altri produttori di serie (twr, byYear) ne passano solo `date`/`value`,
  // ma senza dichiararli qui il tipo diceva meno di quello che la funzione
  // restituisce, e un lettore legittimo di `cost` non compilava.
  cost?: Decimal | DecimalString | number | null;
  accrued?: Decimal | DecimalString | number | null;
  /** Utile/perdita rispetto all'INVESTITO NETTO, non al solo carico. */
  pnl?: Decimal | DecimalString | number | null;
}

/** Un cashflow ridotto a "quanto" e "a quanti giorni dall'inizio": la forma su cui lavora XIRR. */
export interface DayFlow {
  /**
   * Come ogni altro importo del progetto: anche una STRINGA decimale, non solo un
   * Decimal. `npv`/`npvDerivative` lo passano comunque da `d()`, e pretendere un
   * Decimal costringeva il chiamante a convertire un importo che arriva già come
   * stringa dal database.
   */
  amount: Decimal | DecimalString | number;
  days: number;
}
