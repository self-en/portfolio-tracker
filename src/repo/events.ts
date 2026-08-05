// income_events: cedole e dividendi, passati e proiettati.
//
// Le cedole future sono generate dallo scadenzario (status='PROJECTED',
// source='schedule'): è questo che fa funzionare il calendario con copertura
// provider pari a zero sui BTP.
import { query, withTransaction } from "../db/pool";
import * as rows from "./rows";
import { normalizeDate } from "../domain/calendar";
import type { PoolClient } from "pg";
import type { DateString, DecimalString, IncomeEvent } from "../types";

/** Un evento con i pochi dati dello strumento che il calendario mostra accanto. */
export interface IncomeEventWithInstrument extends IncomeEvent {
  instrument: {
    id: number;
    name: string | null;
    ticker: string | null;
    isin: string | null;
    assetClass: string | null;
    faceValue: DecimalString | null;
    quoteConvention: string | null;
  };
}

export interface EventFilter {
  from?: DateString;
  to?: DateString;
  instrumentId?: number;
  kind?: string | string[];
  status?: string | string[];
  portfolioId?: number;
}

/** Un evento come arriva dal provider o dal calcolo delle cedole, prima di essere scritto. */
export interface IncomeEventInput {
  instrumentId: number;
  kind: string;
  status: string;
  exDate?: DateString | null;
  payDate: DateString;
  amountPerUnit?: DecimalString | null;
  currency: string;
  splitRatio?: DecimalString | null;
  source: string;
}

const COLS = `id, instrument_id, kind, status, ex_date, pay_date, amount_per_unit,
  currency, split_ratio, source, transaction_id, created_at, updated_at`;

async function list({ from, to, instrumentId, kind, status, portfolioId }: EventFilter = {}) {
  const params: unknown[] = [];
  const where: string[] = [];
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
    //
    // `IN (subquery)` invece di `EXISTS` correlato: Postgres pianifica entrambi come
    // semi-join, ma la sottoquery non correlata è portabile — pg-mem, usato dai test
    // locali, non risolve gli alias esterni dentro un EXISTS.
    params.push(portfolioId);
    where.push(
      `e.instrument_id IN (SELECT t.instrument_id FROM transactions t
                            WHERE t.portfolio_id = $${params.length}
                              AND t.instrument_id IS NOT NULL)`
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

  return r.map((row): IncomeEventWithInstrument => ({
    ...(rows.incomeEvent(row) as IncomeEvent),
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

async function byId(id: number) {
  const { rows: r } = await query(`SELECT ${COLS} FROM income_events WHERE id = $1`, [id]);
  return rows.incomeEvent(r[0]);
}

/**
 * Upsert sulla chiave naturale (instrument_id, kind, pay_date, ex_date).
 *
 * Un evento già PAID non viene declassato a PROJECTED/ANNOUNCED da un refresh: la
 * conferma dell'utente è il dato più affidabile che abbiamo.
 */
async function upsert(e: IncomeEventInput, client: PoolClient | null = null) {
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

async function upsertMany(events: IncomeEventInput[] | null | undefined): Promise<number> {
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
 * Un evento da proiettare NON porta `instrumentId`: glielo impone
 * `replaceProjected` dal proprio parametro (vedi `{ ...e, instrumentId }` più
 * sotto). Chiederlo anche dentro l'evento significava far dichiarare ai chiamanti
 * un campo che viene sovrascritto — e costringerli a un cast per riuscirci.
 */
export type ProjectedEventInput = Omit<IncomeEventInput, "instrumentId">;

/**
 * Rigenera le cedole proiettate di uno strumento: si cancellano le PROJECTED non
 * ancora collegate a una transazione e si reinseriscono dallo scadenzario.
 *
 * `transaction_id IS NULL` è la guardia importante: un evento confermato
 * dall'utente non deve mai essere cancellato da una rigenerazione.
 */
async function replaceProjected(
  instrumentId: number,
  events: ProjectedEventInput[]
): Promise<number> {
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
async function markPaid(id: number, transactionId: number | null) {
  const { rows: r } = await query(
    `UPDATE income_events SET status = 'PAID', transaction_id = $2, updated_at = now()
      WHERE id = $1 RETURNING ${COLS}`,
    [id, transactionId]
  );
  return rows.incomeEvent(r[0]);
}

async function remove(id: number): Promise<boolean> {
  const { rowCount } = await query("DELETE FROM income_events WHERE id = $1", [id]);
  return (rowCount ?? 0) > 0;
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

export { list, byId, upsert, upsertMany, replaceProjected, markPaid, remove, unreconciledSplits };
