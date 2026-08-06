// SQL di bulk import. Vive qui e non nella route perché il layer repo è l'unico
// posto con SQL (docs/decisions.md §7) — e perché un import è la singola operazione
// più distruttiva dell'app: concentrarla in un modulo la rende rileggibile.
import { withTransaction } from "../db/pool";
import type { PoolClient } from "pg";
import type { DateString, DecimalString, Instrument, Portfolio, Transaction } from "../types";

// Le righe di un dump da importare: gli stessi campi del modello, ma senza gli id
// (che l'import rigenera) e con tutto opzionale tranne l'essenziale - un dump
// scritto a mano non ha l'obbligo di essere completo.
export type ImportPortfolio = Pick<Portfolio, "name"> & Partial<Pick<Portfolio, "baseCcy" | "broker">>;
export type ImportInstrument = Omit<Instrument, "id" | "createdAt" | "updatedAt"> &
  Partial<Pick<Instrument, "metadata" | "active">>;
export type ImportTransaction = Omit<Transaction, "id" | "portfolioId" | "instrumentId" | "createdAt" | "updatedAt">;

/** Le operazioni che il piano di import puo' eseguire dentro l'unica transazione. */
export interface ImportApi {
  wipe: () => Promise<void>;
  listPortfolioNames: () => Promise<Array<{ id: number; name: string }>>;
  insertPortfolio: (p: ImportPortfolio) => Promise<number>;
  instrumentKeys: () => Promise<Map<string, number>>;
  insertInstrument: (i: ImportInstrument) => Promise<number>;
  insertTransaction: (portfolioId: number, instrumentId: number | null, t: ImportTransaction) => Promise<void>;
  insertManualPrice: (instrumentId: number, date: DateString, close: DecimalString) => Promise<void>;
  insertAnalysis: (instrumentId: number, a: ImportAnalysis) => Promise<boolean>;
}

/**
 * Un'analisi da un dump. `createdAt` si CONSERVA: un'analisi è una fotografia
 * datata, e reimportarla con la data di oggi la renderebbe una bugia.
 */
export interface ImportAnalysis {
  createdAt?: string | null;
  model?: string | null;
  effort?: string | null;
  verdict?: string | null;
  confidence?: string | null;
  headline?: string | null;
  analysis?: unknown;
  context?: unknown;
  usage?: unknown;
}

/** Svuota le tabelle di dati, nell'ordine che rispetta le foreign key. */
async function wipe(client: PoolClient) {
  await client.query("DELETE FROM income_events");
  // Prima degli strumenti anche se la foreign key è ON DELETE CASCADE: la cascata
  // funziona, ma un wipe che elenca ciò che cancella si rilegge senza dover andare a
  // controllare lo schema.
  await client.query("DELETE FROM instrument_analyses");
  await client.query("DELETE FROM transactions");
  await client.query("DELETE FROM prices_daily");
  await client.query("DELETE FROM quotes_latest");
  await client.query("DELETE FROM instruments");
}

async function listPortfolioNames(client: PoolClient) {
  const { rows } = await client.query("SELECT id, name FROM portfolios");
  return rows.map((r) => ({ id: Number(r.id), name: r.name }));
}

async function insertPortfolio(client: PoolClient, p: ImportPortfolio) {
  const { rows } = await client.query(
    "INSERT INTO portfolios (name, base_ccy, broker) VALUES ($1,$2,$3) RETURNING id",
    [p.name, p.baseCcy || "EUR", p.broker || null]
  );
  return Number(rows[0].id);
}

/** Chiavi stabili degli strumenti esistenti: ISIN e ticker, non gli id. */
async function instrumentKeys(client: PoolClient) {
  const { rows } = await client.query("SELECT id, isin, ticker FROM instruments");
  const map = new Map();
  for (const r of rows) {
    if (r.isin) map.set(`isin:${r.isin}`, Number(r.id));
    if (r.ticker) map.set(`ticker:${r.ticker}`, Number(r.id));
  }
  return map;
}

async function insertInstrument(client: PoolClient, i: ImportInstrument) {
  const { rows } = await client.query(
    `INSERT INTO instruments (asset_class, name, ticker, isin, exchange, currency,
       price_source, quote_convention, face_value, coupon_rate, coupon_frequency,
       first_coupon_date, maturity_date, day_count, issuer, metadata, notes, active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::date,$13::date,$14,$15,$16,$17,$18)
     RETURNING id`,
    [
      i.assetClass,
      i.name,
      i.ticker || null,
      i.isin || null,
      i.exchange || null,
      i.currency,
      i.priceSource || "yahoo",
      i.quoteConvention || "PRICE",
      i.faceValue ?? null,
      i.couponRate ?? null,
      i.couponFrequency ?? null,
      i.firstCouponDate || null,
      i.maturityDate || null,
      i.dayCount || null,
      i.issuer || null,
      JSON.stringify(i.metadata || {}),
      i.notes || null,
      i.active !== false,
    ]
  );
  return Number(rows[0].id);
}

async function insertTransaction(
  client: PoolClient,
  portfolioId: number,
  instrumentId: number | null,
  t: ImportTransaction
) {
  await client.query(
    `INSERT INTO transactions (portfolio_id, instrument_id, type, trade_date, settle_date,
       quantity, price, gross_amount, fees, taxes, accrued_interest, net_amount,
       trade_ccy, fx_rate, split_ratio, note, external_ref)
     VALUES ($1,$2,$3,$4::date,$5::date,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
    [
      portfolioId,
      instrumentId,
      t.type,
      t.tradeDate,
      t.settleDate || null,
      t.quantity ?? null,
      t.price ?? null,
      t.grossAmount ?? null,
      t.fees ?? "0",
      t.taxes ?? "0",
      t.accruedInterest ?? "0",
      t.netAmount,
      t.tradeCcy || "EUR",
      t.fxRate ?? null,
      t.splitRatio ?? null,
      t.note || null,
      t.externalRef || null,
    ]
  );
}

async function insertManualPrice(client: PoolClient, instrumentId: number, date: DateString, close: DecimalString) {
  await client.query(
    `INSERT INTO prices_daily (instrument_id, price_date, close, source)
     VALUES ($1,$2::date,$3,'manual')
     ON CONFLICT (instrument_id, price_date) DO UPDATE SET close = EXCLUDED.close`,
    [instrumentId, date, close]
  );
}

/**
 * Reinserisce un'analisi già generata.
 *
 * `ON CONFLICT DO NOTHING` sull'indice unico (instrument_id, created_at) rende
 * l'import IDEMPOTENTE: reimportare due volte lo stesso backup non moltiplica le
 * analisi. Restituisce `true` solo se ha davvero inserito, così le statistiche
 * dell'import non mentono.
 *
 * Un'analisi incompleta si SALTA invece di inventarne i campi: `verdict` e
 * `confidence` hanno un CHECK constraint, e un dump modificato a mano non deve
 * poter far fallire l'intera transazione.
 */
async function insertAnalysis(
  client: PoolClient,
  instrumentId: number,
  a: ImportAnalysis
): Promise<boolean> {
  if (!a?.verdict || !a?.confidence || !a?.model) return false;

  // Il duplicato si cerca PRIMA, con una SELECT, invece di affidarsi solo a
  // ON CONFLICT: l'inferenza del conflitto sul vincolo (instrument_id, created_at)
  // è corretta su Postgres ma pg-mem — con cui girano i test in locale — non la
  // applica ai timestamp, quindi l'idempotenza dell'import non sarebbe verificabile.
  // L'ON CONFLICT resta come rete di sicurezza sul database vero.
  if (a.createdAt) {
    const { rows } = await client.query(
      "SELECT 1 FROM instrument_analyses WHERE instrument_id = $1 AND created_at = $2::timestamptz LIMIT 1",
      [instrumentId, a.createdAt]
    );
    if (rows.length > 0) return false;
  }

  const { rowCount } = await client.query(
    `INSERT INTO instrument_analyses
       (instrument_id, model, effort, verdict, confidence, headline, analysis, context, usage, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb, COALESCE($10::timestamptz, now()))
     ON CONFLICT (instrument_id, created_at) DO NOTHING`,
    [
      instrumentId,
      a.model,
      a.effort ?? null,
      a.verdict,
      a.confidence,
      a.headline || "",
      JSON.stringify(a.analysis ?? {}),
      JSON.stringify(a.context ?? {}),
      JSON.stringify(a.usage ?? {}),
      a.createdAt ?? null,
    ]
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Esegue l'import in UNA transazione. `plan` è una callback che riceve i primitivi
 * e decide la mappatura: la logica di rimappatura degli id resta nella route, l'SQL
 * resta qui.
 */
async function runImport<T>(plan: (api: ImportApi) => Promise<T>): Promise<T> {
  return withTransaction((client) =>
    plan({
      wipe: () => wipe(client),
      listPortfolioNames: () => listPortfolioNames(client),
      insertPortfolio: (p) => insertPortfolio(client, p),
      instrumentKeys: () => instrumentKeys(client),
      insertInstrument: (i) => insertInstrument(client, i),
      insertTransaction: (pid, iid, t) => insertTransaction(client, pid, iid, t),
      insertManualPrice: (iid, date, close) => insertManualPrice(client, iid, date, close),
      insertAnalysis: (iid, a) => insertAnalysis(client, iid, a),
    })
  );
}

export { runImport };
