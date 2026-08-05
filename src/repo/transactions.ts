import { query } from "../db/pool";
import * as rows from "./rows";
import { normalizeDate } from "../domain/calendar";

const COLS = `id, portfolio_id, instrument_id, type, trade_date, settle_date, quantity,
  price, gross_amount, fees, taxes, accrued_interest, net_amount, trade_ccy, fx_rate,
  split_ratio, note, external_ref, created_at, updated_at`;

/**
 * Cursore di paginazione keyset su (trade_date, id).
 * Opaco per il client, ma leggibile in debug: è base64url di JSON, non un blob.
 */
const encodeCursor = (row) =>
  Buffer.from(JSON.stringify({ d: row.tradeDate, i: row.id })).toString("base64url");

function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    const o = JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8"));
    if (!o || typeof o.d !== "string" || typeof o.i !== "number") return null;
    return o;
  } catch {
    return null;
  }
}

/**
 * Elenco paginato. Ordine DESCENDENTE per (trade_date, id): il movimento più
 * recente in cima, che è l'ordine in cui si guardano i movimenti.
 *
 * Keyset e non OFFSET: con OFFSET l'inserimento di una transazione durante lo
 * scroll farebbe ricomparire o saltare righe.
 */
async function list({
  portfolioId,
  instrumentId,
  type,
  from,
  to,
  limit = 50,
  cursor,
} = {}) {
  const where = [];
  const params = [];

  if (portfolioId) {
    params.push(portfolioId);
    where.push(`t.portfolio_id = $${params.length}`);
  }
  if (instrumentId) {
    params.push(instrumentId);
    where.push(`t.instrument_id = $${params.length}`);
  }
  if (type) {
    const types = Array.isArray(type) ? type : [type];
    params.push(types);
    where.push(`t.type = ANY($${params.length}::text[])`);
  }
  if (from) {
    params.push(from);
    where.push(`t.trade_date >= $${params.length}::date`);
  }
  if (to) {
    params.push(to);
    where.push(`t.trade_date <= $${params.length}::date`);
  }

  const c = decodeCursor(cursor);
  if (c) {
    // Forma ESPANSA del confronto lessicografico, invece di
    // `(trade_date, id) < ($d, $i)`. Postgres serve entrambe con l'indice
    // (portfolio_id, trade_date, id), ma la forma espansa è portabile: il
    // confronto su tupla non è supportato da pg-mem, che è ciò con cui la
    // paginazione viene testata in locale (qui non c'è Postgres).
    params.push(c.d, c.i);
    const d = `$${params.length - 1}::date`;
    const i = `$${params.length}`;
    where.push(`(t.trade_date < ${d} OR (t.trade_date = ${d} AND t.id < ${i}))`);
  }

  // limit + 1 per sapere se esiste una pagina successiva senza un COUNT separato.
  params.push(Number(limit) + 1);

  const { rows: r } = await query(
    `SELECT ${COLS.split(", ").map((c2) => `t.${c2.trim()}`).join(", ")},
            i.name AS instrument_name, i.ticker AS instrument_ticker,
            i.isin AS instrument_isin, i.asset_class AS instrument_asset_class,
            i.quote_convention AS instrument_quote_convention,
            i.face_value AS instrument_face_value
       FROM transactions t
       LEFT JOIN instruments i ON i.id = t.instrument_id
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY t.trade_date DESC, t.id DESC
      LIMIT $${params.length}`,
    params
  );

  const hasMore = r.length > Number(limit);
  const page = hasMore ? r.slice(0, Number(limit)) : r;
  const items = page.map((row) => ({
    ...rows.transaction(row),
    instrument: row.instrument_id
      ? {
          id: Number(row.instrument_id),
          name: row.instrument_name,
          ticker: row.instrument_ticker,
          isin: row.instrument_isin,
          assetClass: row.instrument_asset_class,
          quoteConvention: row.instrument_quote_convention,
          faceValue: row.instrument_face_value,
        }
      : null,
  }));

  return {
    items,
    nextCursor: hasMore && items.length ? encodeCursor(items[items.length - 1]) : null,
  };
}

/** TUTTE le transazioni di un portafoglio, ordine ASCENDENTE: l'input di domain/. */
async function ledger({ portfolioId, instrumentId, asOf } = {}) {
  const where = [];
  const params = [];
  if (portfolioId) {
    params.push(portfolioId);
    where.push(`portfolio_id = $${params.length}`);
  }
  if (instrumentId) {
    params.push(instrumentId);
    where.push(`instrument_id = $${params.length}`);
  }
  if (asOf) {
    params.push(asOf);
    where.push(`trade_date <= $${params.length}::date`);
  }
  const { rows: r } = await query(
    `SELECT ${COLS} FROM transactions
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY trade_date ASC, id ASC`,
    params
  );
  return r.map(rows.transaction);
}

/** Ledger raggruppato per strumento: la forma che valueSeries() si aspetta. */
async function ledgerByInstrument(args) {
  const all = await ledger(args);
  const map = new Map();
  for (const tx of all) {
    if (tx.instrumentId == null) continue;
    if (!map.has(tx.instrumentId)) map.set(tx.instrumentId, []);
    map.get(tx.instrumentId).push(tx);
  }
  return map;
}

async function byId(id) {
  const { rows: r } = await query(`SELECT ${COLS} FROM transactions WHERE id = $1`, [id]);
  return rows.transaction(r[0]);
}

const FIELDS = [
  ["portfolioId", "portfolio_id"],
  ["instrumentId", "instrument_id"],
  ["type", "type"],
  ["tradeDate", "trade_date"],
  ["settleDate", "settle_date"],
  ["quantity", "quantity"],
  ["price", "price"],
  ["grossAmount", "gross_amount"],
  ["fees", "fees"],
  ["taxes", "taxes"],
  ["accruedInterest", "accrued_interest"],
  ["netAmount", "net_amount"],
  ["tradeCcy", "trade_ccy"],
  ["fxRate", "fx_rate"],
  ["splitRatio", "split_ratio"],
  ["note", "note"],
  ["externalRef", "external_ref"],
];

async function create(input, client = null) {
  const q = client ? client.query.bind(client) : query;
  const cols = [];
  const params = [];
  const placeholders = [];
  for (const [key, col] of FIELDS) {
    if (input[key] === undefined) continue;
    cols.push(col);
    params.push(input[key] === "" ? null : input[key]);
    placeholders.push(`$${params.length}`);
  }
  const { rows: r } = await q(
    `INSERT INTO transactions (${cols.join(", ")}) VALUES (${placeholders.join(", ")})
     RETURNING ${COLS}`,
    params
  );
  return rows.transaction(r[0]);
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
    `UPDATE transactions SET ${sets.join(", ")} WHERE id = $${params.length} RETURNING ${COLS}`,
    params
  );
  return rows.transaction(r[0]);
}

async function remove(id) {
  const { rowCount } = await query("DELETE FROM transactions WHERE id = $1", [id]);
  return (rowCount ?? 0) > 0;
}

/** Prima data di transazione: origine della griglia della serie storica. */
async function earliestDate(portfolioId) {
  const { rows: r } = await query(
    `SELECT MIN(trade_date) AS d FROM transactions ${portfolioId ? "WHERE portfolio_id = $1" : ""}`,
    portfolioId ? [portfolioId] : []
  );
  return normalizeDate(r[0].d) || null;
}

/** Prima data per strumento: quanto indietro deve andare il backfill dei prezzi. */
async function earliestDateByInstrument(instrumentId) {
  const { rows: r } = await query(
    "SELECT MIN(trade_date) AS d FROM transactions WHERE instrument_id = $1",
    [instrumentId]
  );
  return normalizeDate(r[0].d) || null;
}

/** Redditi aggregati per periodo, lordo/ritenuta/netto separati. */
async function incomeByPeriod({ portfolioId, from, to, groupBy = "month" }) {
  const params = [];
  const where = [`t.type IN ('DIVIDEND','COUPON','INTEREST')`];
  if (portfolioId) {
    params.push(portfolioId);
    where.push(`t.portfolio_id = $${params.length}`);
  }
  if (from) {
    params.push(from);
    where.push(`t.trade_date >= $${params.length}::date`);
  }
  if (to) {
    params.push(to);
    where.push(`t.trade_date <= $${params.length}::date`);
  }

  // Il raggruppamento è scelto tra due alternative fisse, non interpolato
  // dall'input: nessuna via per un'iniezione.
  const keyExpr =
    groupBy === "instrument"
      ? "COALESCE(i.name, 'n/d')"
      : "to_char(t.trade_date, 'YYYY-MM')";

  const { rows: r } = await query(
    `SELECT ${keyExpr} AS key,
            SUM(COALESCE(t.gross_amount, t.net_amount)) AS gross,
            SUM(t.taxes) AS taxes,
            SUM(COALESCE(t.gross_amount, t.net_amount) - t.taxes) AS net,
            COUNT(*)::int AS count,
            MIN(t.trade_ccy) AS currency
       FROM transactions t
       LEFT JOIN instruments i ON i.id = t.instrument_id
      WHERE ${where.join(" AND ")}
      GROUP BY key
      ORDER BY key`,
    params
  );

  return r.map((x) => ({
    key: x.key,
    gross: x.gross,
    taxes: x.taxes,
    net: x.net,
    count: Number(x.count),
    currency: x.currency ? x.currency.trim() : null,
  }));
}

export { list, ledger, ledgerByInstrument, byId, create, update, remove, earliestDate, earliestDateByInstrument, incomeByPeriod, encodeCursor, decodeCursor };
