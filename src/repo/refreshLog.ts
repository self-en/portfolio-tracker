// refresh_log: ogni tentativo di refresh, per rendere osservabile il layer di
// mercato senza dover leggere i log (e per alimentare /api/system/status e Grafana).
import { query } from "../db/pool";

/** Apre una riga di log e restituisce l'id. */
async function start(job: string, target: string | null = null) {
  const { rows } = await query(
    "INSERT INTO refresh_log (job, target) VALUES ($1, $2) RETURNING id",
    [job, target]
  );
  return Number(rows[0].id);
}

async function finish(
  id: number | null,
  { ok, error = null, rowCount = null }: { ok: boolean; error?: string | null; rowCount?: number | null }
) {
  await query(
    `UPDATE refresh_log SET finished_at = now(), ok = $2, error = $3, row_count = $4 WHERE id = $1`,
    [id, ok, error ? String(error).slice(0, 2000) : null, rowCount]
  );
}

/** Ultimo esito per ciascun job: input del catch-up al boot. */
async function lastRuns() {
  const { rows } = await query(
    `SELECT DISTINCT ON (job) job, started_at, finished_at, ok, error, row_count
       FROM refresh_log ORDER BY job, started_at DESC`
  );
  return Object.fromEntries(
    rows.map((r) => [
      r.job,
      {
        startedAt: r.started_at,
        finishedAt: r.finished_at,
        ok: r.ok,
        error: r.error,
        rowCount: r.row_count,
      },
    ])
  );
}

/** Ultimo successo di un job: serve a decidere se è stale da più di un intervallo. */
async function lastSuccess(job: string) {
  const { rows } = await query(
    `SELECT started_at, finished_at, row_count FROM refresh_log
      WHERE job = $1 AND ok = TRUE ORDER BY started_at DESC LIMIT 1`,
    [job]
  );
  return rows[0]
    ? { startedAt: rows[0].started_at, finishedAt: rows[0].finished_at, rowCount: rows[0].row_count }
    : null;
}

async function recent(job: string | null = null, limit = 50) {
  const { rows } = await query(
    `SELECT id, job, target, started_at, finished_at, ok, error, row_count
       FROM refresh_log ${job ? "WHERE job = $1" : ""}
      ORDER BY started_at DESC LIMIT ${job ? "$2" : "$1"}`,
    job ? [job, limit] : [limit]
  );
  return rows.map((r) => ({
    id: Number(r.id),
    job: r.job,
    target: r.target,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    ok: r.ok,
    error: r.error,
    rowCount: r.row_count,
  }));
}

/** Potatura: il log cresce senza limite, e oltre qualche migliaia di righe non serve. */
async function prune(keepDays = 30) {
  const { rowCount } = await query(
    `DELETE FROM refresh_log WHERE started_at < now() - ($1 || ' days')::interval`,
    [String(keepDays)]
  );
  return rowCount ?? 0;
}

export { start, finish, lastRuns, lastSuccess, recent, prune };
