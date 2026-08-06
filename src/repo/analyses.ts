// Analisi degli strumenti generate con Claude (tabella `instrument_analyses`).
//
// Si conserva lo STORICO, non solo l'ultima: due analisi a sei mesi di distanza
// sullo stesso titolo sono il dato più interessante che questa funzione produce
// ("cosa è cambiato nel giudizio"), e cancellare la precedente per risparmiare
// qualche kilobyte butterebbe via una chiamata già pagata.
import { query } from "../db/pool";
import * as rows from "./rows";
import { inList } from "./sqlUtil";
import type { AnalysisPayload, AnalysisUsage, InstrumentAnalysis } from "../types";

const COLS = `id, instrument_id, model, effort, verdict, confidence, headline,
  analysis, context, usage, created_at`;

export interface AnalysisInput {
  instrumentId: number;
  model: string;
  effort: string | null;
  verdict: string;
  confidence: string;
  headline: string;
  analysis: AnalysisPayload;
  context: Record<string, unknown>;
  usage: AnalysisUsage;
}

/**
 * Inserisce una nuova analisi. Mai UPDATE: la storia è append-only.
 *
 * I tre JSONB si passano come stringa JSON e non come oggetto: `pg` serializzerebbe
 * comunque, ma pg-mem si comporta diversamente sui due percorsi, e un test che
 * scrive un oggetto e rilegge una stringa (o viceversa) fallisce per un motivo che
 * non c'entra niente con quello che sta verificando.
 */
async function create(input: AnalysisInput): Promise<InstrumentAnalysis | null> {
  const { rows: r } = await query(
    `INSERT INTO instrument_analyses
       (instrument_id, model, effort, verdict, confidence, headline, analysis, context, usage)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb)
     RETURNING ${COLS}`,
    [
      input.instrumentId,
      input.model,
      input.effort,
      input.verdict,
      input.confidence,
      input.headline,
      JSON.stringify(input.analysis ?? {}),
      JSON.stringify(input.context ?? {}),
      JSON.stringify(input.usage ?? {}),
    ]
  );
  return rows.instrumentAnalysis(r[0]);
}

/** L'ultima analisi di uno strumento, o null se non è mai stata fatta. */
async function latest(instrumentId: number): Promise<InstrumentAnalysis | null> {
  const { rows: r } = await query(
    `SELECT ${COLS} FROM instrument_analyses
      WHERE instrument_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`,
    [instrumentId]
  );
  return rows.instrumentAnalysis(r[0]);
}

/** Lo storico di uno strumento, dalla più recente. */
async function history(instrumentId: number, limit = 10): Promise<InstrumentAnalysis[]> {
  const { rows: r } = await query(
    `SELECT ${COLS} FROM instrument_analyses
      WHERE instrument_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`,
    [instrumentId, limit]
  );
  return rows.mapAll(r, rows.instrumentAnalysis);
}

async function byId(id: number): Promise<InstrumentAnalysis | null> {
  const { rows: r } = await query(`SELECT ${COLS} FROM instrument_analyses WHERE id = $1`, [id]);
  return rows.instrumentAnalysis(r[0]);
}

/**
 * L'ultima analisi per ciascuno degli strumenti indicati: è quello che serve alla
 * LISTA degli strumenti, che altrimenti farebbe una query per riga.
 *
 * Nessuna window function (`DISTINCT ON`, `ROW_NUMBER() OVER`): pg-mem non le
 * implementa, e la lista degli strumenti di un portafoglio personale sta in poche
 * decine di righe — il raggruppamento sull'id massimo costa niente e gira su
 * entrambi. `id` è SERIAL, quindi il massimo id è anche la più recente.
 */
async function latestForMany(
  instrumentIds: readonly number[]
): Promise<Map<number, InstrumentAnalysis>> {
  const out = new Map<number, InstrumentAnalysis>();
  if (!instrumentIds || instrumentIds.length === 0) return out;

  const params: unknown[] = [];
  const { rows: ids } = await query(
    `SELECT MAX(id)::int AS id FROM instrument_analyses
      WHERE instrument_id ${inList(params, instrumentIds)}
      GROUP BY instrument_id`,
    params
  );
  const wanted = ids.map((x) => Number(x.id)).filter((n) => Number.isFinite(n));
  if (wanted.length === 0) return out;

  const params2: unknown[] = [];
  const { rows: r } = await query(
    `SELECT ${COLS} FROM instrument_analyses WHERE id ${inList(params2, wanted)}`,
    params2
  );
  for (const a of rows.mapAll(r, rows.instrumentAnalysis)) out.set(a.instrumentId, a);
  return out;
}

/** Quante analisi esistono in totale (per /api/system/status e per l'export). */
async function count(): Promise<number> {
  const { rows: r } = await query("SELECT COUNT(*)::int AS n FROM instrument_analyses");
  return Number(r[0].n);
}

async function remove(id: number): Promise<boolean> {
  const { rowCount } = await query("DELETE FROM instrument_analyses WHERE id = $1", [id]);
  return (rowCount ?? 0) > 0;
}

export { create, latest, history, byId, latestForMany, count, remove };
