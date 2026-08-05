// Il modello di dominio, in un posto solo.
//
// Due convenzioni che questo file rende esplicite nei tipi, e che prima vivevano
// solo nei commenti:
//
//  1. **I numerici sono STRINGHE.** I type parser in src/db/pool.ts disattivano la
//     conversione a `number` di NUMERIC/int8: un float64 non rappresenta 0.1, e su
//     una catena qty×prezzo×fx l'errore si accumula fino a essere visibile in euro.
//     Il calcolo passa sempre da Decimal (src/domain/money.ts), il trasporto da
//     stringa. `DecimalString` marca questi campi: se ne vedi uno in un'espressione
//     aritmetica, è un bug.
//  2. **Le date sono stringhe "YYYY-MM-DD"**, mai `Date`. Un oggetto Date porta con
//     sé un fuso orario e un istante, che per una data di valuta non significano
//     niente e fanno sbagliare i confronti a cavallo di mezzanotte.
export type DateString = string;
export type DecimalString = string;
/** Codice valuta ISO 4217, sempre già trimmato (le colonne sono CHAR(3)). */
export type Ccy = string;
/** Timestamp ISO, così come arriva dal database. */
export type Timestamp = string;

export type AssetClass = string;
export type TransactionType = string;

export interface Instrument {
  id: number;
  assetClass: AssetClass;
  name: string;
  ticker: string | null;
  isin: string | null;
  exchange: string | null;
  currency: Ccy;
  priceSource: string | null;
  quoteConvention: string | null;
  faceValue: DecimalString | null;
  couponRate: DecimalString | null;
  couponFrequency: number | null;
  firstCouponDate: DateString | null;
  maturityDate: DateString | null;
  dayCount: string | null;
  issuer: string | null;
  metadata: Record<string, unknown>;
  notes: string | null;
  active: boolean;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface Transaction {
  id: number;
  portfolioId: number;
  instrumentId: number | null;
  type: TransactionType;
  tradeDate: DateString;
  settleDate: DateString | null;
  quantity: DecimalString | null;
  price: DecimalString | null;
  grossAmount: DecimalString | null;
  fees: DecimalString | null;
  taxes: DecimalString | null;
  accruedInterest: DecimalString | null;
  netAmount: DecimalString | null;
  tradeCcy: Ccy;
  fxRate: DecimalString | null;
  splitRatio: DecimalString | null;
  note: string | null;
  externalRef: string | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface Portfolio {
  id: number;
  name: string;
  baseCcy: Ccy;
  broker: string | null;
  createdAt: Timestamp;
}

export interface Price {
  instrumentId: number | undefined;
  date: DateString;
  close: DecimalString | null;
  adjClose: DecimalString | null;
  open: DecimalString | null;
  high: DecimalString | null;
  low: DecimalString | null;
  volume: DecimalString | null;
  source: string | null;
  fetchedAt: Timestamp | null;
}

export interface Quote {
  instrumentId: number;
  price: DecimalString | null;
  currency: Ccy;
  previousClose: DecimalString | null;
  marketState: string | null;
  quoteTime: Timestamp | null;
  source: string | null;
  fetchedAt: Timestamp | null;
}

export interface FxRate {
  date: DateString;
  baseCcy: Ccy;
  quoteCcy: Ccy;
  rate: DecimalString;
  source: string | null;
  isFilled: boolean;
  fetchedAt: Timestamp | null;
}

export interface IncomeEvent {
  id: number;
  instrumentId: number;
  kind: string;
  status: string;
  exDate: DateString | null;
  payDate: DateString | null;
  amountPerUnit: DecimalString | null;
  currency: Ccy;
  splitRatio: DecimalString | null;
  source: string | null;
  transactionId: number | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/**
 * Una riga così come torna da `pg`: i nomi sono snake_case e i valori arrivano
 * come stringhe (o null). È deliberatamente permissiva - la conoscenza della
 * forma vive nei mapper di src/repo/rows.ts, che sono l'unico posto autorizzato a
 * leggerne i campi.
 */
export type DbRow = Record<string, any>;
