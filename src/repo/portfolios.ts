import { query } from "../db/pool";
import * as rows from "./rows";
import type { Portfolio } from "../types";

const COLS = "id, name, base_ccy, broker, created_at";

async function list(): Promise<Array<Portfolio | null>> {
  const { rows: r } = await query(`SELECT ${COLS} FROM portfolios ORDER BY id ASC`);
  return rows.mapAll(r, rows.portfolio);
}

async function byId(id: number): Promise<Portfolio | null> {
  const { rows: r } = await query(`SELECT ${COLS} FROM portfolios WHERE id = $1`, [id]);
  return rows.portfolio(r[0]);
}

/** Il portafoglio di default: quello seminato dalla migrazione 002, o il primo. */
async function first(): Promise<Portfolio | null> {
  const { rows: r } = await query(`SELECT ${COLS} FROM portfolios ORDER BY id ASC LIMIT 1`);
  return rows.portfolio(r[0]);
}

async function create({
  name,
  baseCcy = "EUR",
  broker = null,
}: {
  name: string;
  baseCcy?: string;
  broker?: string | null;
}): Promise<Portfolio | null> {
  const { rows: r } = await query(
    `INSERT INTO portfolios (name, base_ccy, broker) VALUES ($1, $2, $3) RETURNING ${COLS}`,
    [name, baseCcy, broker]
  );
  return rows.portfolio(r[0]);
}

async function update(id: number, patch: Partial<Pick<Portfolio, "name" | "baseCcy" | "broker">>): Promise<Portfolio | null> {
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [key, col] of [
    ["name", "name"],
    ["baseCcy", "base_ccy"],
    ["broker", "broker"],
  ]) {
    const value = patch[key as keyof typeof patch];
    if (value === undefined) continue;
    params.push(value === "" ? null : value);
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

async function remove(id: number): Promise<boolean> {
  const { rowCount } = await query("DELETE FROM portfolios WHERE id = $1", [id]);
  return (rowCount ?? 0) > 0;
}

/** Quante transazioni referenziano il portafoglio (per il 409 su DELETE). */
async function transactionCount(id: number): Promise<number> {
  const { rows: r } = await query(
    "SELECT COUNT(*)::int AS n FROM transactions WHERE portfolio_id = $1",
    [id]
  );
  return Number(r[0].n);
}

export { list, byId, first, create, update, remove, transactionCount };
