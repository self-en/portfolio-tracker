// income_events: cedole e dividendi, passati e proiettati.
//
// Le cedole future sono generate dallo scadenzario (status='PROJECTED',
// source='schedule'): è questo che fa funzionare il calendario con copertura
// provider pari a zero sui BTP.
const { query, withTransaction } = require("../db/pool");
const rows = require("./rows");
const { normalizeDate } = require("../domain/calendar");

const COLS = `id, instrument_id, kind, status, ex_date, pay_date, amount_per_unit,
  currency, split_ratio, source, transaction_id, created_at, updated_at`;

async function list({ from, to, instrumentId, kind, status, portfolioId } = {}) {
  const params = [];
  const where = [];
  if (from) {
    params.push(from);
    where.push(`e.pay_date >= $${params.length}::date`);
  }
  if (to) {
    params.push(to);
    where.push(`e.pay_date <= $${params.length}::date`);
  }
  if (instrumentId) {
    params.push(instrumentId);
    where.push(`e.instrument_id = $${params.length}`);
  }
  if (kind) {
    params.push(Array.isArray(kind) ? kind : [kind]);
    where.push(`e.kind = ANY($${params.length}::text[])`);
  }
  if (status) {
    params.push(Array.isArray(status) ? status : [status]);
    where.push(`e.status = ANY($${params.length}::text[])`);
  }
  if (portfolioId) {
    // Solo strumenti che il portafoglio ha effettivamente movimentato: un
    // calendario che mostra cedole di titoli mai comprati è rumore.
    params.push(portfolioId);
    where.push(
      `EXISTS (SELECT 1 FROM transactions t
                WHERE t.instrument_id = e.instrument_id AND t.portfolio_id = $${params.length})`
    );
  }

  const { rows: r } = await query(
    `SELECT ${COLS.split(",").map((c) => `e.${c.trim()}`).join(", ")},
            i.name AS instrument_name, i.ticker AS instrument_ticker,
            i.isin AS instrument_isin, i.asset_class AS instrument_asset_class,
            i.face_value AS instrument_face_value,
            i.quote_convention AS instrument_quote_convention
       FROM income_events e
       JOIN instruments i ON i.id = e.instrument_id
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY e.pay_date ASC, e.instrument_id ASC, e.id ASC`,
    params
  );

  return r.map((row) => ({
    ...rows.incomeEvent(row),
    instrument: {
      id: Number(row.instrument_id),
      name: row.instrument_name,
      ticker: row.instrument_ticker,
      isin: row.instrument_isin,
      assetClass: row.instrument_asset_class,
      faceValue: row.instrument_face_value,
      quoteConvention: row.instrument_quote_convention,
    },
  }));
}

async function byId(id) {
  const { rows: r } = await query(`SELECT ${COLS} FROM income_events WHERE id = $1`, [id]);
  return rows.incomeEvent(r[0]);
}

/**
 * Upsert sulla chiave naturale (instrument_id, kind, pay_date, ex_date).
 *
 * Un evento già PAID non viene declassato a PROJECTED/ANNOUNCED da un refresh: la
 * conferma dell'utente è il dato più affidabile che abbiamo.
 */
async function upsert(e, client = null) {
  const q = client ? client.query.bind(client) : query;
  const { rows: r } = await q(
    `INSERT INTO income_events
       (instrument_id, kind, status, ex_date, pay_date, amount_per_unit, currency, split_ratio, source)
     VALUES ($1, $2, $3, $4::date, $5::date, $6, $7, $8, $9)
     ON CONFLICT (instrument_id, kind, pay_date, COALESCE(ex_date, DATE '1900-01-01'))
     DO UPDATE SET
       amount_per_unit = EXCLUDED.amount_per_unit,
       currency = EXCLUDED.currency,
       split_ratio = EXCLUDED.split_ratio,
       status = CASE WHEN income_events.status = 'PAID' THEN 'PAID' ELSE EXCLUDED.status END,
       source = CASE WHEN income_events.status = 'PAID' THEN income_events.source ELSE EXCLUDED.source END,
       updated_at = now()
     RETURNING ${COLS}`,
    [
      e.instrumentId,
      e.kind,
      e.status,
      e.exDate || null,
      e.payDate,
      e.amountPerUnit ?? null,
      e.currency,
      e.splitRatio ?? null,
      e.source,
    ]
  );
  return rows.incomeEvent(r[0]);
}

async function upsertMany(events) {
  if (!events || events.length === 0) return 0;
  return withTransaction(async (client) => {
    let n = 0;
    for (const e of events) {
      await upsert(e, client);
      n += 1;
    }
    return n;
  });
}

/**
 * Rigenera le cedole proiettate di uno strumento: si cancellano le PROJECTED non
 * ancora collegate a una transazione e si reinseriscono dallo scadenzario.
 *
 * `transaction_id IS NULL` è la guardia importante: un evento confermato
 * dall'utente non deve mai essere cancellato da una rigenerazione.
 */
async function replaceProjected(instrumentId, events) {
  return withTransaction(async (client) => {
    await client.query(
      `DELETE FROM income_events
        WHERE instrument_id = $1 AND status = 'PROJECTED' AND transaction_id IS NULL`,
      [instrumentId]
    );
    let n = 0;
    for (const e of events) {
      await upsert({ ...e, instrumentId }, client);
      n += 1;
    }
    return n;
  });
}

/** Collega un evento alla transazione che lo realizza e lo porta a PAID. */
async function markPaid(id, transactionId) {
  const { rows: r } = await query(
    `UPDATE income_events SET status = 'PAID', transaction_id = $2, updated_at = now()
      WHERE id = $1 RETURNING ${COLS}`,
    [id, transactionId]
  );
  return rows.incomeEvent(r[0]);
}

async function remove(id) {
  const { rowCount } = await query("DELETE FROM income_events WHERE id = $1", [id]);
  return rowCount > 0;
}

/** Split scoperti da un refresh e non ancora riconciliati in una transazione. */
async function unreconciledSplits() {
  const { rows: r } = await query(
    `SELECT e.id, e.instrument_id, e.pay_date, e.split_ratio, i.name, i.ticker
       FROM income_events e
       JOIN instruments i ON i.id = e.instrument_id
      WHERE e.kind = 'SPLIT' AND e.transaction_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM transactions t
           WHERE t.instrument_id = e.instrument_id
             AND t.type = 'SPLIT' AND t.trade_date = e.pay_date)
      ORDER BY e.pay_date DESC`
  );
  return r.map((x) => ({
    id: Number(x.id),
    instrumentId: Number(x.instrument_id),
    date: normalizeDate(x.pay_date),
    ratio: x.split_ratio,
    name: x.name,
    ticker: x.ticker,
  }));
}

module.exports = {
  list,
  byId,
  upsert,
  upsertMany,
  replaceProjected,
  markPaid,
  remove,
  unreconciledSplits,
};
