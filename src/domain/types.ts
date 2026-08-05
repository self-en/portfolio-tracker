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
  [key: string]: unknown;
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
  [key: string]: unknown;
}

/**
 * Un avvertimento che accompagna un risultato invece di interromperlo: un tasso
 * mancante produce un numero comunque, ma con `partial: true` e questo warning -
 * mai un errore silenzioso ne' un'eccezione.
 */
export interface DomainWarning {
  code: string;
  message: string;
  instrumentId?: number | null;
  txId?: number | null;
  currency?: Ccy | null;
  date?: DateString | null;
  [key: string]: unknown;
}

/** Tasso EUR->ccy alla data, dalla cache. null/'' = non disponibile. */
export type FxLookup = (ccy: Ccy, date: DateString | null) => DecimalString | number | null | undefined;

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
  date: DateString;
  amount: Decimal | DecimalString | number;
  /** Importo gia' convertito in valuta base, quando il produttore lo conosce. */
  amountBase?: Decimal | DecimalString | number | null;
  /** BUY/SELL/DIVIDEND/... - decide se il flusso e' capitale (vedi CAPITAL_TYPES). */
  type?: string;
  [key: string]: unknown;
}

/** Un punto di una serie temporale: valore alla data (null = non disponibile). */
export interface SeriesPoint {
  date: DateString;
  value: Decimal | DecimalString | number | null;
  /** true quando il punto e' stato calcolato con dati incompleti. */
  partial?: boolean;
  [key: string]: unknown;
}

/** Un cashflow ridotto a "quanto" e "a quanti giorni dall'inizio": la forma su cui lavora XIRR. */
export interface DayFlow {
  amount: Decimal;
  days: number;
}
