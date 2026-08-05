// Mappatura riga ↔ oggetto. Il layer repo è l'UNICO posto che conosce i nomi
// snake_case delle colonne: sopra di lui tutto è camelCase.
//
// I numerici restano STRINGHE (i type parser in src/db/pool.js lo garantiscono) e
// non vengono mai convertiti qui.
//
// Le DATE invece vengono normalizzate a "YYYY-MM-DD" anche qui, come cintura di
// sicurezza. Il type parser sull'OID 1082 è un effetto collaterale GLOBALE del
// require di pool.js: se un percorso di codice interrogasse il database prima che
// quel require sia avvenuto, le date tornerebbero come oggetti Date e ogni
// confronto di stringhe a valle si romperebbe in silenzio. Normalizzare qui rende
// il contratto del repo ("le date sono stringhe") vero per costruzione, e
// indipendente dal driver (pg-mem, per esempio, non passa dai type parser di pg).
import { normalizeDate } from "../domain/calendar";
import type {
  DateString,
  DbRow,
  FxRate,
  IncomeEvent,
  Instrument,
  Portfolio,
  Price,
  Quote,
  Transaction,
} from "../types";

const dateOf = (v: unknown): DateString | null =>
  v === null || v === undefined ? null : normalizeDate(v as string);

// Per le colonne dichiarate NOT NULL nello schema (001_init.sql): trade_date,
// price_date, rate_date. Il non-null qui riflette un vincolo del database, non
// un'ipotesi ottimistica - se un giorno quel vincolo cambiasse, il tipo del
// modello va cambiato con lui.
const requiredDate = (v: unknown): DateString => dateOf(v) as DateString;
const trimmed = (v: unknown): string => (typeof v === "string" ? v.trim() : (v as string));

const instrument = (r: DbRow | null | undefined): Instrument | null =>
  r == null
    ? null
    : {
        id: Number(r.id),
        assetClass: r.asset_class,
        name: r.name,
        ticker: r.ticker,
        isin: r.isin,
        exchange: r.exchange,
        currency: trimmed(r.currency),
        priceSource: r.price_source,
        quoteConvention: r.quote_convention,
        faceValue: r.face_value,
        couponRate: r.coupon_rate,
        couponFrequency: r.coupon_frequency === null ? null : Number(r.coupon_frequency),
        firstCouponDate: dateOf(r.first_coupon_date),
        maturityDate: dateOf(r.maturity_date),
        dayCount: r.day_count,
        issuer: r.issuer,
        metadata: r.metadata || {},
        notes: r.notes,
        active: r.active,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      };

const transaction = (r: DbRow | null | undefined): Transaction | null =>
  r == null
    ? null
    : {
        id: Number(r.id),
        portfolioId: Number(r.portfolio_id),
        instrumentId: r.instrument_id === null ? null : Number(r.instrument_id),
        type: r.type,
        tradeDate: requiredDate(r.trade_date),
        settleDate: dateOf(r.settle_date),
        quantity: r.quantity,
        price: r.price,
        grossAmount: r.gross_amount,
        fees: r.fees,
        taxes: r.taxes,
        accruedInterest: r.accrued_interest,
        netAmount: r.net_amount,
        tradeCcy: trimmed(r.trade_ccy),
        fxRate: r.fx_rate,
        splitRatio: r.split_ratio,
        note: r.note,
        externalRef: r.external_ref,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      };

const portfolio = (r: DbRow | null | undefined): Portfolio | null =>
  r == null
    ? null
    : {
        id: Number(r.id),
        name: r.name,
        baseCcy: trimmed(r.base_ccy),
        broker: r.broker,
        createdAt: r.created_at,
      };

const price = (r: DbRow | null | undefined): Price | null =>
  r == null
    ? null
    : {
        instrumentId: r.instrument_id === undefined ? undefined : Number(r.instrument_id),
        date: requiredDate(r.price_date),
        close: r.close,
        adjClose: r.adj_close,
        open: r.open,
        high: r.high,
        low: r.low,
        volume: r.volume,
        source: r.source,
        fetchedAt: r.fetched_at,
      };

const quote = (r: DbRow | null | undefined): Quote | null =>
  r == null
    ? null
    : {
        instrumentId: Number(r.instrument_id),
        price: r.price,
        currency: trimmed(r.currency),
        previousClose: r.previous_close,
        marketState: r.market_state,
        quoteTime: r.quote_time,
        source: r.source,
        fetchedAt: r.fetched_at,
      };

const fxRate = (r: DbRow | null | undefined): FxRate | null =>
  r == null
    ? null
    : {
        date: requiredDate(r.rate_date),
        baseCcy: trimmed(r.base_ccy),
        quoteCcy: trimmed(r.quote_ccy),
        rate: r.rate,
        source: r.source,
        isFilled: r.is_filled,
        fetchedAt: r.fetched_at,
      };

const incomeEvent = (r: DbRow | null | undefined): IncomeEvent | null =>
  r == null
    ? null
    : {
        id: Number(r.id),
        instrumentId: Number(r.instrument_id),
        kind: r.kind,
        status: r.status,
        exDate: dateOf(r.ex_date),
        payDate: dateOf(r.pay_date),
        amountPerUnit: r.amount_per_unit,
        currency: trimmed(r.currency),
        splitRatio: r.split_ratio,
        source: r.source,
        transactionId: r.transaction_id === null ? null : Number(r.transaction_id),
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      };

export { instrument, transaction, portfolio, price, quote, fxRate, incomeEvent };
