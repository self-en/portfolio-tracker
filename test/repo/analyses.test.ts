// Il repository delle analisi su pg-mem.
//
// SCOPO: intercettare errori SQL prima del deploy (in locale non c'è Postgres). Non
// si asserisce la precisione NUMERIC — qui non ce n'è: le analisi sono testo e JSONB.
// Per PRIMO: imposta l'env prima che qualsiasi import carichi src/config.
import "../helpers/env";

import test from "node:test";
import assert from "node:assert/strict";

import { freshMemDb } from "../helpers/memdb";
import { must } from "../helpers/must";

import * as instrumentsRepo from "../../src/repo/instruments";
import * as analysesRepo from "../../src/repo/analyses";
import type { AnalysisPayload } from "../../src/types";

const EQ = {
  assetClass: "EQUITY",
  name: "Acme SpA",
  ticker: "ACME.MI",
  isin: "IT0001234567",
  currency: "EUR",
};
const EQ2 = { ...EQ, name: "Beta SpA", ticker: "BETA.MI", isin: "IT0007654321" };

const payload = (over: Partial<AnalysisPayload> = {}): AnalysisPayload => ({
  headline: "Bilancio solido",
  summary: "Riassunto.",
  financialHealth: { score: 4, label: "solida", notes: ["nota"] },
  valuation: { assessment: "EQUA", notes: [] },
  strengths: [{ title: "Cassa", detail: "Abbondante." }],
  risks: [{ title: "Ciclicità", detail: "Domanda volatile.", severity: "MEDIA" }],
  positionAdvice: "Mantenere il peso attuale.",
  watchlist: ["margine lordo"],
  dataGaps: [],
  ...over,
});

const input = (instrumentId: number, over: Record<string, unknown> = {}) => ({
  instrumentId,
  model: "claude-opus-5",
  effort: "high",
  verdict: "MANTENERE",
  confidence: "MEDIA",
  headline: "Bilancio solido",
  analysis: payload(),
  context: { generatedAt: "2026-08-06T10:00:00.000Z", gaps: ["nessuna posizione"] },
  usage: { inputTokens: 100, outputTokens: 20, servedBy: "claude-opus-5" },
  ...over,
});

test("create → latest round-trip, con i JSONB rileggibili come oggetti", async () => {
  await freshMemDb();
  const inst = must(await instrumentsRepo.create(EQ), "lo strumento");

  const created = must(await analysesRepo.create(input(inst.id)), "l'analisi creata");
  assert.ok(created.id > 0);
  assert.equal(created.instrumentId, inst.id);
  assert.equal(created.verdict, "MANTENERE");
  assert.equal(created.effort, "high");

  const read = must(await analysesRepo.latest(inst.id), "l'ultima analisi");
  assert.equal(read.id, created.id);
  // JSONB: devono tornare oggetti, non stringhe. pg li restituisce già parsati,
  // pg-mem no — è il mapper in repo/rows.ts a rendere il contratto vero su entrambi.
  assert.equal(typeof read.analysis, "object");
  assert.equal(read.analysis.financialHealth.score, 4);
  assert.equal(read.analysis.risks[0].severity, "MEDIA");
  assert.deepEqual(read.context.gaps, ["nessuna posizione"]);
  assert.equal(read.usage.inputTokens, 100);
  assert.equal(read.usage.servedBy, "claude-opus-5");
});

test("latest su uno strumento senza analisi è null, non un errore", async () => {
  await freshMemDb();
  const inst = must(await instrumentsRepo.create(EQ), "lo strumento");
  assert.equal(await analysesRepo.latest(inst.id), null);
  assert.deepEqual(await analysesRepo.history(inst.id), []);
  assert.equal(await analysesRepo.count(), 0);
});

test("lo storico è append-only e ordinato dalla più recente", async () => {
  await freshMemDb();
  const inst = must(await instrumentsRepo.create(EQ), "lo strumento");

  const first = must(await analysesRepo.create(input(inst.id, { verdict: "COMPRARE" })), "la prima");
  const second = must(await analysesRepo.create(input(inst.id, { verdict: "RIDURRE" })), "la seconda");

  // Nessun UPDATE: una nuova analisi non sovrascrive la precedente. Confrontare due
  // giudizi a distanza di mesi è il dato più interessante di questa funzione.
  const history = await analysesRepo.history(inst.id);
  assert.equal(history.length, 2);
  assert.equal(history[0].id, second.id, "la più recente in cima");
  assert.equal(history[1].id, first.id);
  assert.equal(must(await analysesRepo.latest(inst.id), "l'ultima").verdict, "RIDURRE");
  assert.equal(await analysesRepo.count(), 2);

  // Il limite dello storico è rispettato.
  assert.equal((await analysesRepo.history(inst.id, 1)).length, 1);
});

test("latestForMany: una sola query per la lista, l'ultima analisi per strumento", async () => {
  await freshMemDb();
  const a = must(await instrumentsRepo.create(EQ), "il primo strumento");
  const b = must(await instrumentsRepo.create(EQ2), "il secondo strumento");

  await analysesRepo.create(input(a.id, { verdict: "COMPRARE" }));
  const lastA = must(await analysesRepo.create(input(a.id, { verdict: "EVITARE" })), "l'ultima di A");
  const onlyB = must(await analysesRepo.create(input(b.id, { verdict: "MANTENERE" })), "quella di B");

  const map = await analysesRepo.latestForMany([a.id, b.id, 99999]);
  assert.equal(map.size, 2, "chi non ha analisi non compare");
  assert.equal(must(map.get(a.id), "A").id, lastA.id, "solo la PIÙ RECENTE per strumento");
  assert.equal(must(map.get(a.id), "A").verdict, "EVITARE");
  assert.equal(must(map.get(b.id), "B").id, onlyB.id);

  // Lista vuota: nessuna query, nessun errore.
  assert.equal((await analysesRepo.latestForMany([])).size, 0);
});

test("byId e remove", async () => {
  await freshMemDb();
  const inst = must(await instrumentsRepo.create(EQ), "lo strumento");
  const created = must(await analysesRepo.create(input(inst.id)), "l'analisi");

  assert.equal(must(await analysesRepo.byId(created.id), "letta per id").id, created.id);
  assert.equal(await analysesRepo.byId(999999), null);
  assert.equal(await analysesRepo.remove(created.id), true);
  assert.equal(await analysesRepo.remove(created.id), false, "cancellare due volte non è un errore");
  assert.equal(await analysesRepo.latest(inst.id), null);
});

test("cancellare lo strumento porta via le sue analisi (ON DELETE CASCADE)", async () => {
  await freshMemDb();
  const inst = must(await instrumentsRepo.create(EQ), "lo strumento");
  await analysesRepo.create(input(inst.id));
  assert.equal(await analysesRepo.count(), 1);

  // Le analisi non devono trattenere uno strumento: si rifanno, a differenza dei
  // movimenti (che invece producono un 409).
  assert.equal(await instrumentsRepo.remove(inst.id), true);
  assert.equal(await analysesRepo.count(), 0);
});
