const { query } = require("../db/pool");
const rows = require("./rows");
const { normalizeDate } = require("../domain/calendar");
const { inList } = require("./sqlUtil");

/** Serie prezzi di uno strumento. Righe SPARSE: il forward-fill lo fa domain/. */
async function series(instrumentId, { from, to } = {}) {
  const params = [instrumentId];
  const where = ["instrument_id = $1"];
  if (from) {
    params.push(from);
    where.push(`price_date >= $${params.length}::date`);
  }
  if (to) {
    params.push(to);
    where.push(`price_date <= $${params.length}::date`);
  }
  const { rows: r } = await query(
    `SELECT instrument_id, price_date, close, adj_close, open, high, low, volume, source, fetched_at
       FROM prices_daily WHERE ${where.join(" AND ")} ORDER BY price_date ASC`,
    params
  );
  return r.map(rows.price);
}

/** Serie per più strumenti in UNA query, raggruppate: evita N+1 su value-series. */
async function seriesForMany(instrumentIds, { from, to } = {}) {
  const map = new Map();
  if (!instrumentIds || instrumentIds.length === 0) return map;
  const params = [];
  const where = [`instrument_id ${inList(params, instrumentIds)}`];
  if (from) {
    params.push(from);
    where.push(`price_date >= $${params.length}::date`);
  }
  if (to) {
    params.push(to);
    where.push(`price_date <= $${params.length}::date`);
  }
  const { rows: r } = await query(
    `SELECT instrument_id, price_date, close, source
       FROM prices_daily WHERE ${where.join(" AND ")}
      ORDER BY instrument_id, price_date ASC`,
    params
  );
  for (const row of r) {
    const id = Number(row.instrument_id);
    if (!map.has(id)) map.set(id, []);
    map.get(id).push({ date: normalizeDate(row.price_date), close: row.close, source: row.source });
  }
  return map;
}

/**
 * L'ultimo prezzo NOTO a una data, per strumento. Forward-fill fatto in SQL con
 * DISTINCT ON — è l'unico posto dove conviene, perché evita di trasferire tutta la
 * storia solo per leggerne l'ultima riga.
 */
async function latestAsOf(instrumentIds, asOf) {
  const map = new Map();
  if (!instrumentIds || instrumentIds.length === 0) return map;
  const params = [];
  const idIn = inList(params, instrumentIds);
  params.push(asOf);
  const { rows: r } = await query(
    `SELECT DISTINCT ON (instrument_id) instrument_id, price_date, close, source
       FROM prices_daily
      WHERE instrument_id ${idIn} AND price_date <= $${params.length}::date
      ORDER BY instrument_id, price_date DESC`,
    params
  );
  for (const row of r) {
    map.set(Number(row.instrument_id), {
      price: row.close,
      priceDate: normalizeDate(row.price_date),
      asOf: normalizeDate(row.price_date),
      source: row.source,
    });
  }
  return map;
}

/** Prezzo del giorno precedente a quello noto, per la variazione giornaliera. */
async function previousCloseAsOf(instrumentIds, asOf) {
  const map = new Map();
  if (!instrumentIds || instrumentIds.length === 0) return map;
  const params2 = [];
  const idIn2 = inList(params2, instrumentIds);
  params2.push(asOf);
  const { rows: r } = await query(
    `SELECT instrument_id, close FROM (
       SELECT instrument_id, close,
              ROW_NUMBER() OVER (PARTITION BY instrument_id ORDER BY price_date DESC) AS rn
         FROM prices_daily
        WHERE instrument_id ${idIn2} AND price_date <= $${params2.length}::date
     ) s WHERE rn = 2`,
    params2
  );
  for (const row of r) map.set(Number(row.instrument_id), row.close);
  return map;
}

/**
 * Upsert di barre giornaliere. Idempotente sulla chiave (instrument_id, price_date).
 *
 * Un prezzo MANUALE non viene sovrascritto da uno automatico: per le obbligazioni il
 * dato inserito a mano è l'unico che esiste, e un refresh non deve poterlo
 * cancellare. Il contrario è permesso (una correzione manuale vince).
 */
async function upsertBars(instrumentId, bars, source = "yahoo") {
  if (!bars || bars.length === 0) return 0;
  let count = 0;
  // Batch da 500: un singolo INSERT con migliaia di tuple supera il limite di
  // parametri di Postgres (65535).
  const CHUNK = 500;
  for (let i = 0; i < bars.length; i += CHUNK) {
    const chunk = bars.slice(i, i + CHUNK);
    const params = [];
    const values = chunk.map((b) => {
      params.push(
        instrumentId,
        b.date,
        b.close,
        b.adjClose ?? null,
        b.open ?? null,
        b.high ?? null,
        b.low ?? null,
        b.volume ?? null,
        source
      );
      const n = params.length;
      return `($${n - 8}, $${n - 7}::date, $${n - 6}, $${n - 5}, $${n - 4}, $${n - 3}, $${n - 2}, $${n - 1}, $${n})`;
    });
    const { rowCount } = await query(
      `INSERT INTO prices_daily
         (instrument_id, price_date, close, adj_close, open, high, low, volume, source)
       VALUES ${values.join(", ")}
       ON CONFLICT (instrument_id, price_date) DO UPDATE SET
         close = EXCLUDED.close, adj_close = EXCLUDED.adj_close, open = EXCLUDED.open,
         high = EXCLUDED.high, low = EXCLUDED.low, volume = EXCLUDED.volume,
         source = EXCLUDED.source, fetched_at = now()
       WHERE prices_daily.source <> 'manual' OR EXCLUDED.source = 'manual'`,
      params
    );
    count += rowCount;
  }
  return count;
}

/** Prezzo manuale: il percorso principale per le obbligazioni. */
async function upsertManual(instrumentId, date, close) {
  const { rows: r } = await query(
    `INSERT INTO prices_daily (instrument_id, price_date, close, source)
     VALUES ($1, $2::date, $3, 'manual')
     ON CONFLICT (instrument_id, price_date) DO UPDATE SET
       close = EXCLUDED.close, source = 'manual', fetched_at = now()
     RETURNING instrument_id, price_date, close, adj_close, open, high, low, volume, source, fetched_at`,
    [instrumentId, date, close]
  );
  return rows.price(r[0]);
}

async function deleteAll(instrumentId) {
  const { rowCount } = await query("DELETE FROM prices_daily WHERE instrument_id = $1", [
    instrumentId,
  ]);
  return rowCount;
}

// --- quotes_latest ---

async function upsertQuote(q) {
  const { rows: r } = await query(
    `INSERT INTO quotes_latest
       (instrument_id, price, currency, previous_close, market_state, quote_time, source, fetched_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now())
     ON CONFLICT (instrument_id) DO UPDATE SET
       price = EXCLUDED.price, currency = EXCLUDED.currency,
       previous_close = EXCLUDED.previous_close, market_state = EXCLUDED.market_state,
       quote_time = EXCLUDED.quote_time, source = EXCLUDED.source, fetched_at = now()
     RETURNING instrument_id, price, currency, previous_close, market_state, quote_time, source, fetched_at`,
    [
      q.instrumentId,
      q.price,
      q.currency,
      q.previousClose ?? null,
      q.marketState ?? null,
      q.quoteTime ?? null,
      q.source || "yahoo",
    ]
  );
  return rows.quote(r[0]);
}

async function latestQuotes(instrumentIds) {
  const map = new Map();
  if (!instrumentIds || instrumentIds.length === 0) return map;
  const params = [];
  const { rows: r } = await query(
    `SELECT instrument_id, price, currency, previous_close, market_state, quote_time, source, fetched_at
       FROM quotes_latest WHERE instrument_id ${inList(params, instrumentIds)}`,
    params
  );
  for (const row of r) map.set(Number(row.instrument_id), rows.quote(row));
  return map;
}

module.exports = {
  series,
  seriesForMany,
  latestAsOf,
  previousCloseAsOf,
  upsertBars,
  upsertManual,
  deleteAll,
  upsertQuote,
  latestQuotes,
};
