// Tassi di cambio. CONVENZIONE: rate = unità di quote_ccy per 1 base_ccy, e
// base_ccy è sempre 'EUR'. Per convertire X → EUR si DIVIDE (docs/decisions.md §2).
import { query } from "../db/pool";
import * as rows from "./rows";
import { normalizeDate } from "../domain/calendar";
import { inList } from "./sqlUtil";
import type { DateString, DecimalString } from "../types";

/** Un tasso come arriva dal provider FX, prima di essere scritto. */
export interface FxRecord {
  date: DateString;
  base?: string;
  quote: string;
  rate: DecimalString | number;
  isFilled?: boolean;
}

export interface FxListFilter {
  quotes?: readonly string[];
  date?: DateString;
  from?: DateString;
  to?: DateString;
  base?: string;
}

const BASE = "EUR";

/** Serie sparse per valuta, nella forma che valueSeries() si aspetta. */
async function seriesForMany(
  quoteCcys: readonly string[] | null | undefined,
  { from, to, base = BASE }: { from?: DateString; to?: DateString; base?: string } = {}
) {
  const map = new Map<string, Array<{ date: DateString; rate: DecimalString }>>();
  const ccys = (quoteCcys || []).filter((c: string) => c && c !== base);
  if (ccys.length === 0) return map;

  const params = [base];
  const where = ["base_ccy = $1", `quote_ccy ${inList(params, ccys)}`];
  if (from) {
    params.push(from);
    where.push(`rate_date >= $${params.length}::date`);
  }
  if (to) {
    params.push(to);
    where.push(`rate_date <= $${params.length}::date`);
  }
  const { rows: r } = await query(
    `SELECT rate_date, quote_ccy, rate FROM fx_rates_daily
      WHERE ${where.join(" AND ")} ORDER BY quote_ccy, rate_date ASC`,
    params
  );
  for (const row of r) {
    const ccy = row.quote_ccy.trim();
    let series = map.get(ccy);
    if (!series) {
      series = [];
      map.set(ccy, series);
    }
    series.push({ date: normalizeDate(row.rate_date) as DateString, rate: row.rate });
  }
  return map;
}

/** Ultimo tasso noto a una data, per valuta. Forward-fill in SQL. */
async function ratesAsOf(quoteCcys: readonly string[] | null | undefined, asOf: DateString, base = BASE) {
  const map = new Map();
  const ccys = (quoteCcys || []).filter((c) => c && c !== base);
  if (ccys.length === 0) return map;
  const params = [base];
  const ccyIn = inList(params, ccys);
  params.push(asOf);
  const { rows: r } = await query(
    `SELECT DISTINCT ON (quote_ccy) quote_ccy, rate, rate_date
       FROM fx_rates_daily
      WHERE base_ccy = $1 AND quote_ccy ${ccyIn} AND rate_date <= $${params.length}::date
      ORDER BY quote_ccy, rate_date DESC`,
    params
  );
  for (const row of r) map.set(row.quote_ccy.trim(), row.rate);
  return map;
}

/** Un singolo tasso, con la data effettiva da cui viene (per dire "al ..."). */
async function rateAsOf(quoteCcy: string, asOf: DateString, base = BASE) {
  if (!quoteCcy || quoteCcy === base) return { rate: "1", date: asOf, base, quote: base };
  const { rows: r } = await query(
    `SELECT rate, rate_date, is_filled FROM fx_rates_daily
      WHERE base_ccy = $1 AND quote_ccy = $2 AND rate_date <= $3::date
      ORDER BY rate_date DESC LIMIT 1`,
    [base, quoteCcy, asOf]
  );
  if (!r[0]) return null;
  return {
    rate: r[0].rate,
    date: normalizeDate(r[0].rate_date),
    isFilled: r[0].is_filled,
    base,
    quote: quoteCcy,
  };
}

/** Upsert di una serie di tassi. Idempotente: i tassi storici non cambiano mai. */
async function upsertRates(records: FxRecord[] | null | undefined, source = "frankfurter"): Promise<number> {
  if (!records || records.length === 0) return 0;
  let count = 0;
  const CHUNK = 500;
  for (let i = 0; i < records.length; i += CHUNK) {
    const chunk = records.slice(i, i + CHUNK);
    const params: unknown[] = [];
    const values = chunk.map((x) => {
      params.push(x.date, x.base || BASE, x.quote, x.rate, source, !!x.isFilled);
      const n = params.length;
      return `($${n - 5}::date, $${n - 4}, $${n - 3}, $${n - 2}, $${n - 1}, $${n})`;
    });
    const { rowCount } = await query(
      `INSERT INTO fx_rates_daily (rate_date, base_ccy, quote_ccy, rate, source, is_filled)
       VALUES ${values.join(", ")}
       ON CONFLICT (rate_date, base_ccy, quote_ccy) DO UPDATE SET
         rate = EXCLUDED.rate, source = EXCLUDED.source,
         is_filled = EXCLUDED.is_filled, fetched_at = now()
       WHERE fx_rates_daily.is_filled = TRUE OR EXCLUDED.is_filled = FALSE`,
      params
    );
    count += rowCount ?? 0;
  }
  return count;
}

/** Copertura per valuta: che range di date abbiamo già. */
async function coverage(base = BASE) {
  const { rows: r } = await query(
    `SELECT quote_ccy, MIN(rate_date) AS from_date, MAX(rate_date) AS to_date, COUNT(*)::int AS rows
       FROM fx_rates_daily WHERE base_ccy = $1 GROUP BY quote_ccy ORDER BY quote_ccy`,
    [base]
  );
  return r.map((x) => ({
    currency: x.quote_ccy.trim(),
    from: normalizeDate(x.from_date),
    to: normalizeDate(x.to_date),
    rows: Number(x.rows),
  }));
}

async function list({ quotes, date, from, to, base = BASE }: FxListFilter = {}) {
  const params: unknown[] = [base];
  const where = ["base_ccy = $1"];
  if (quotes && quotes.length) {
    where.push(`quote_ccy ${inList(params, quotes)}`);
  }
  if (date) {
    params.push(date);
    where.push(`rate_date = $${params.length}::date`);
  }
  if (from) {
    params.push(from);
    where.push(`rate_date >= $${params.length}::date`);
  }
  if (to) {
    params.push(to);
    where.push(`rate_date <= $${params.length}::date`);
  }
  const { rows: r } = await query(
    `SELECT rate_date, base_ccy, quote_ccy, rate, source, is_filled, fetched_at
       FROM fx_rates_daily WHERE ${where.join(" AND ")}
      ORDER BY rate_date DESC, quote_ccy LIMIT 2000`,
    params
  );
  return rows.mapAll(r, rows.fxRate);
}

export { BASE, seriesForMany, ratesAsOf, rateAsOf, upsertRates, coverage, list };
