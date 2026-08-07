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
 * Si raggruppa su `MAX(created_at)`, NON su `MAX(id)`. La differenza non è
 * accademica: l'import CONSERVA il `created_at` originale (un'analisi è una
 * fotografia datata), e l'export le emette dalla più recente — quindi dopo un
 * reimport la più recente ha l'id più BASSO, e `MAX(id)` avrebbe mostrato in lista
 * un verdetto diverso da quello del dettaglio. Bug trovato in review, non in
 * produzione: qui c'è il test che lo blocca.
 *
 * Nessuna window function (`DISTINCT ON`, `ROW_NUMBER() OVER`): pg-mem non le
 * implementa, e la lista degli strumenti di un portafoglio personale sta in poche
 * decine di righe. Due query invece di una, entrambe portabili.
 */
async function latestForMany(
  instrumentIds: readonly number[]
): Promise<Map<number, InstrumentAnalysis>> {
  const out = new Map<number, InstrumentAnalysis>();
  if (!instrumentIds || instrumentIds.length === 0) return out;

  const params: unknown[] = [];
  const { rows: latestByInstrument } = await query(
    `SELECT instrument_id, MAX(created_at) AS created_at FROM instrument_analyses
      WHERE instrument_id ${inList(params, instrumentIds)}
      GROUP BY instrument_id`,
    params
  );
  if (latestByInstrument.length === 0) return out;

  // Coppie (strumento, istante): il vincolo unico su quelle due colonne garantisce
  // una riga per coppia. Forma espansa e non `(a,b) IN ((…),(…))` per lo stesso
  // motivo di `inList`: la portabilità verso pg-mem (vedi repo/sqlUtil.ts).
  const params2: unknown[] = [];
  const conditions = latestByInstrument.map((x) => {
    params2.push(Number(x.instrument_id), x.created_at);
    return `(instrument_id = $${params2.length - 1} AND created_at = $${params2.length})`;
  });
  const { rows: r } = await query(
    `SELECT ${COLS} FROM instrument_analyses WHERE ${conditions.join(" OR ")}`,
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
