const { query } = require("../db/pool");
const rows = require("./rows");
const { normalizeDate } = require("../domain/calendar");
const { inList } = require("./sqlUtil");

const COLS = `id, asset_class, name, ticker, isin, exchange, currency, price_source,
  quote_convention, face_value, coupon_rate, coupon_frequency, first_coupon_date,
  maturity_date, day_count, issuer, metadata, notes, active, created_at, updated_at`;

async function list({ q, assetClass, active, priceSource } = {}) {
  const where = [];
  const params = [];

  if (q) {
    params.push(`%${q}%`);
    // Ricerca su nome, ticker e ISIN: sono i tre modi in cui si cerca un titolo.
    where.push(
      `(name ILIKE $${params.length} OR ticker ILIKE $${params.length} OR isin ILIKE $${params.length})`
    );
  }
  if (assetClass) {
    params.push(assetClass);
    where.push(`asset_class = $${params.length}`);
  }
  if (active !== undefined && active !== null) {
    params.push(active);
    where.push(`active = $${params.length}`);
  }
  if (priceSource) {
    params.push(priceSource);
    where.push(`price_source = $${params.length}`);
  }

  const sql = `SELECT ${COLS} FROM instruments
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY name ASC, id ASC`;
  const { rows: r } = await query(sql, params);
  return r.map(rows.instrument);
}

async function byId(id) {
  const { rows: r } = await query(`SELECT ${COLS} FROM instruments WHERE id = $1`, [id]);
  return rows.instrument(r[0]);
}

async function byIds(ids) {
  if (!ids || ids.length === 0) return [];
  const params = [];
  const { rows: r } = await query(
    `SELECT ${COLS} FROM instruments WHERE id ${inList(params, ids)}`,
    params
  );
  return r.map(rows.instrument);
}

/** Mappa id → strumento, la forma che si passa a domain/. */
async function mapByIds(ids) {
  const list_ = await byIds(ids);
  return new Map(list_.map((i) => [i.id, i]));
}

async function byIsinOrTicker({ isin, ticker }) {
  const { rows: r } = await query(
    `SELECT ${COLS} FROM instruments
      WHERE ($1::text IS NOT NULL AND isin = $1) OR ($2::text IS NOT NULL AND ticker = $2)
      LIMIT 1`,
    [isin || null, ticker || null]
  );
  return rows.instrument(r[0]);
}

const FIELDS = [
  ["assetClass", "asset_class"],
  ["name", "name"],
  ["ticker", "ticker"],
  ["isin", "isin"],
  ["exchange", "exchange"],
  ["currency", "currency"],
  ["priceSource", "price_source"],
  ["quoteConvention", "quote_convention"],
  ["faceValue", "face_value"],
  ["couponRate", "coupon_rate"],
  ["couponFrequency", "coupon_frequency"],
  ["firstCouponDate", "first_coupon_date"],
  ["maturityDate", "maturity_date"],
  ["dayCount", "day_count"],
  ["issuer", "issuer"],
  ["metadata", "metadata"],
  ["notes", "notes"],
  ["active", "active"],
];

async function create(input) {
  const cols = [];
  const params = [];
  const placeholders = [];
  for (const [key, col] of FIELDS) {
    if (input[key] === undefined) continue;
    cols.push(col);
    params.push(input[key] === "" ? null : input[key]);
    placeholders.push(`$${params.length}`);
  }
  const { rows: r } = await query(
    `INSERT INTO instruments (${cols.join(", ")}) VALUES (${placeholders.join(", ")})
     RETURNING ${COLS}`,
    params
  );
  return rows.instrument(r[0]);
}

async function update(id, patch) {
  const sets = [];
  const params = [];
  for (const [key, col] of FIELDS) {
    if (patch[key] === undefined) continue;
    params.push(patch[key] === "" ? null : patch[key]);
    sets.push(`${col} = $${params.length}`);
  }
  if (sets.length === 0) return byId(id);
  sets.push("updated_at = now()");
  params.push(id);
  const { rows: r } = await query(
    `UPDATE instruments SET ${sets.join(", ")} WHERE id = $${params.length} RETURNING ${COLS}`,
    params
  );
  return rows.instrument(r[0]);
}

async function remove(id) {
  const { rowCount } = await query("DELETE FROM instruments WHERE id = $1", [id]);
  return rowCount > 0;
}

/** Quante transazioni referenziano lo strumento (per il 409 su DELETE). */
async function transactionCount(id) {
  const { rows: r } = await query(
    "SELECT COUNT(*)::int AS n FROM transactions WHERE instrument_id = $1",
    [id]
  );
  return Number(r[0].n);
}

/** Copertura della serie prezzi, per /api/instruments/:id e per il reconciler. */
async function priceCoverage(id) {
  const { rows: r } = await query(
    `SELECT MIN(price_date) AS from_date, MAX(price_date) AS to_date, COUNT(*)::int AS rows
       FROM prices_daily WHERE instrument_id = $1`,
    [id]
  );
  // normalizeDate: vedi la nota in rows.js — il contratto "le date sono stringhe"
  // vale anche per le colonne aggregate, che non passano dai row mapper.
  return {
    from: normalizeDate(r[0].from_date),
    to: normalizeDate(r[0].to_date),
    rows: Number(r[0].rows),
  };
}

/**
 * Strumenti da rinfrescare: attivi, con price_source diverso da 'manual'.
 * I bond a pricing manuale sono esclusi di proposito — Yahoo non li copre
 * (verificato in Fase 0) e interrogarlo sprecherebbe budget di rate limit.
 */
async function refreshable() {
  const { rows: r } = await query(
    `SELECT ${COLS} FROM instruments
      WHERE active = TRUE AND price_source = 'yahoo' AND ticker IS NOT NULL
      ORDER BY id`
  );
  return r.map(rows.instrument);
}

/**
 * Strumenti la cui copertura prezzi non arriva a `throughDate`: è la query che il
 * reconciler al boot usa per riaccodare i backfill perduti (la coda è in memoria e
 * i pod ripartono a ogni push).
 */
async function staleCoverage(throughDate) {
  const { rows: r } = await query(
    `SELECT i.id, i.name, i.ticker, MAX(p.price_date) AS last_price
       FROM instruments i
       LEFT JOIN prices_daily p ON p.instrument_id = i.id
      WHERE i.active = TRUE AND i.price_source = 'yahoo' AND i.ticker IS NOT NULL
      GROUP BY i.id, i.name, i.ticker
     HAVING MAX(p.price_date) IS NULL OR MAX(p.price_date) < $1::date
      ORDER BY i.id`,
    [throughDate]
  );
  return r.map((x) => ({
    id: Number(x.id),
    name: x.name,
    ticker: x.ticker,
    lastPrice: normalizeDate(x.last_price),
  }));
}

/** Valute distinte in uso, per garantire la copertura FX. */
async function currenciesInUse() {
  const { rows: r } = await query(
    `SELECT DISTINCT currency FROM instruments WHERE active = TRUE
      UNION SELECT DISTINCT trade_ccy FROM transactions`
  );
  return r.map((x) => (x.currency || "").trim()).filter(Boolean);
}

module.exports = {
  list,
  byId,
  byIds,
  mapByIds,
  byIsinOrTicker,
  create,
  update,
  remove,
  transactionCount,
  priceCoverage,
  refreshable,
  staleCoverage,
  currenciesInUse,
};
