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
const { normalizeDate } = require("../domain/calendar");

const dateOf = (v) => (v === null || v === undefined ? v : normalizeDate(v));

const instrument = (r) =>
  r == null
    ? null
    : {
        id: Number(r.id),
        assetClass: r.asset_class,
        name: r.name,
        ticker: r.ticker,
        isin: r.isin,
        exchange: r.exchange,
        currency: r.currency ? r.currency.trim() : r.currency,
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

const transaction = (r) =>
  r == null
    ? null
    : {
        id: Number(r.id),
        portfolioId: Number(r.portfolio_id),
        instrumentId: r.instrument_id === null ? null : Number(r.instrument_id),
        type: r.type,
        tradeDate: dateOf(r.trade_date),
        settleDate: dateOf(r.settle_date),
        quantity: r.quantity,
        price: r.price,
        grossAmount: r.gross_amount,
        fees: r.fees,
        taxes: r.taxes,
        accruedInterest: r.accrued_interest,
        netAmount: r.net_amount,
        tradeCcy: r.trade_ccy ? r.trade_ccy.trim() : r.trade_ccy,
        fxRate: r.fx_rate,
        splitRatio: r.split_ratio,
        note: r.note,
        externalRef: r.external_ref,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      };

const portfolio = (r) =>
  r == null
    ? null
    : {
        id: Number(r.id),
        name: r.name,
        baseCcy: r.base_ccy ? r.base_ccy.trim() : r.base_ccy,
        broker: r.broker,
        createdAt: r.created_at,
      };

const price = (r) =>
  r == null
    ? null
    : {
        instrumentId: r.instrument_id === undefined ? undefined : Number(r.instrument_id),
        date: dateOf(r.price_date),
        close: r.close,
        adjClose: r.adj_close,
        open: r.open,
        high: r.high,
        low: r.low,
        volume: r.volume,
        source: r.source,
        fetchedAt: r.fetched_at,
      };

const quote = (r) =>
  r == null
    ? null
    : {
        instrumentId: Number(r.instrument_id),
        price: r.price,
        currency: r.currency ? r.currency.trim() : r.currency,
        previousClose: r.previous_close,
        marketState: r.market_state,
        quoteTime: r.quote_time,
        source: r.source,
        fetchedAt: r.fetched_at,
      };

const fxRate = (r) =>
  r == null
    ? null
    : {
        date: dateOf(r.rate_date),
        baseCcy: r.base_ccy ? r.base_ccy.trim() : r.base_ccy,
        quoteCcy: r.quote_ccy ? r.quote_ccy.trim() : r.quote_ccy,
        rate: r.rate,
        source: r.source,
        isFilled: r.is_filled,
        fetchedAt: r.fetched_at,
      };

const incomeEvent = (r) =>
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
        currency: r.currency ? r.currency.trim() : r.currency,
        splitRatio: r.split_ratio,
        source: r.source,
        transactionId: r.transaction_id === null ? null : Number(r.transaction_id),
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      };

module.exports = { instrument, transaction, portfolio, price, quote, fxRate, incomeEvent };
