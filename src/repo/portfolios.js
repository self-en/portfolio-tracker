const { query } = require("../db/pool");
const rows = require("./rows");

const COLS = "id, name, base_ccy, broker, created_at";

async function list() {
  const { rows: r } = await query(`SELECT ${COLS} FROM portfolios ORDER BY id ASC`);
  return r.map(rows.portfolio);
}

async function byId(id) {
  const { rows: r } = await query(`SELECT ${COLS} FROM portfolios WHERE id = $1`, [id]);
  return rows.portfolio(r[0]);
}

/** Il portafoglio di default: quello seminato dalla migrazione 002, o il primo. */
async function first() {
  const { rows: r } = await query(`SELECT ${COLS} FROM portfolios ORDER BY id ASC LIMIT 1`);
  return rows.portfolio(r[0]);
}

async function create({ name, baseCcy = "EUR", broker = null }) {
  const { rows: r } = await query(
    `INSERT INTO portfolios (name, base_ccy, broker) VALUES ($1, $2, $3) RETURNING ${COLS}`,
    [name, baseCcy, broker]
  );
  return rows.portfolio(r[0]);
}

async function update(id, patch) {
  const sets = [];
  const params = [];
  for (const [key, col] of [
    ["name", "name"],
    ["baseCcy", "base_ccy"],
    ["broker", "broker"],
  ]) {
    if (patch[key] === undefined) continue;
    params.push(patch[key] === "" ? null : patch[key]);
    sets.push(`${col} = $${params.length}`);
  }
  if (sets.length === 0) return byId(id);
  params.push(id);
  const { rows: r } = await query(
    `UPDATE portfolios SET ${sets.join(", ")} WHERE id = $${params.length} RETURNING ${COLS}`,
    params
  );
  return rows.portfolio(r[0]);
}

async function remove(id) {
  const { rowCount } = await query("DELETE FROM portfolios WHERE id = $1", [id]);
  return rowCount > 0;
}

module.exports = { list, byId, first, create, update, remove };
