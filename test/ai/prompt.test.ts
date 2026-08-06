// Prompt, schema dell'output e confine del modulo `src/ai/`.
//
// Nessuna rete: le funzioni qui sono pure, e questo file esiste perché un prompt
// sbagliato è un bug come un altro — solo che si paga a ogni analisi e si scopre
// leggendo una risposta invece di un errore.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import * as prompt from "../../src/ai/prompt";
import { payloadSchema, decisionSchema } from "../../src/ai/instrumentAnalysis";
import { importsOf, readSources, runtimeImportsOf } from "../helpers/sourceScan";
import type { AnalysisContext } from "../../src/ai/prompt";

/** Un contesto minimo ma completo: azione con fondamentali e posizione. */
function context(over: Partial<AnalysisContext> = {}): AnalysisContext {
  return {
    generatedAt: "2026-08-06T10:00:00.000Z",
    baseCcy: "EUR",
    instrument: {
      id: 7,
      name: "Acme SpA",
      assetClass: "EQUITY",
      ticker: "ACME.MI",
      isin: "IT0001234567",
      exchange: "MTA",
      currency: "EUR",
      priceSource: "yahoo",
      quoteConvention: "PRICE",
      issuer: null,
      notes: null,
      active: true,
    },
    bond: null,
    couponSchedule: null,
    currentYield: null,
    quote: {
      price: "12.5",
      currency: "EUR",
      previousClose: "12.4",
      asOf: "2026-08-06T09:00:00.000Z",
      marketState: "REGULAR",
      source: "yahoo",
    },
    priceCoverage: { from: "2024-01-01", to: "2026-08-05", rows: 400 },
    risk: null,
    fundamentals: null,
    position: null,
    portfolio: { id: 1, name: "Principale" },
    portfolioValue: "100000.000000",
    provider: "yahoo",
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Prompt di sistema
// ---------------------------------------------------------------------------

test("il prompt di sistema NON contiene dati dello strumento (altrimenti la cache non serve)", () => {
  // La cache dei prompt è un PREFISSO: mettere il nome del titolo nel prompt di
  // sistema lo invaliderebbe a ogni analisi, in silenzio e a pagamento.
  const sys = prompt.buildSystemPrompt("EQUITY");
  for (const leak of ["Acme", "ACME.MI", "IT0001234567", "12.5"]) {
    assert.ok(!sys.includes(leak), `il prompt di sistema contiene ${leak}`);
  }
});

test("ogni classe di attivo ha il suo blocco, e una classe sconosciuta non lascia il prompt nudo", () => {
  const equity = prompt.buildSystemPrompt("EQUITY");
  const bond = prompt.buildSystemPrompt("BOND");
  const etf = prompt.buildSystemPrompt("etf"); // minuscolo: la classe arriva dal database
  const strano = prompt.buildSystemPrompt("QUALCOSALTRO");

  assert.ok(equity.includes("CLASSE: AZIONE"));
  assert.ok(bond.includes("CLASSE: OBBLIGAZIONE"));
  assert.ok(etf.includes("CLASSE: ETF"), "il confronto sulla classe è insensibile al caso");
  assert.ok(strano.includes("NON CLASSIFICATA"));
  assert.notEqual(equity, bond);

  // Tutti condividono lo stesso PREFISSO: è ciò che rende la cache utile.
  for (const p of [equity, bond, etf, strano]) {
    assert.ok(p.startsWith(prompt.BASE_SYSTEM), "il blocco della classe va APPESO, non interpolato");
  }
});

test("il prompt dichiara le convenzioni numeriche che si sbagliano più facilmente", () => {
  const sys = prompt.buildSystemPrompt("EQUITY");
  // Ognuna di queste, letta male, produce un'analisi sbagliata di un fattore 100.
  assert.match(sys, /debtToEquity/, "il debt/equity di Yahoo è in percentuale: va detto");
  assert.match(sys, /FRAZIONI/);
  assert.match(sys, /couponRate/);
  assert.match(sys, /PCT_OF_NOMINAL/);
  assert.match(sys, /currentYield/);
  assert.match(sys, /rendimento a scadenza/, "il rendimento corrente NON è lo YTM");
  // Realizzato, redditi e latente non si sommano MAI in un unico profitto
  // (docs/decisions.md §3): è la regola che un modello violerebbe per default.
  assert.match(sys, /TRE VOCI SEPARATE/);
  assert.match(sys, /baseCcy/, "quali importi sono in EUR e quali in valuta dello strumento");
});

test("il prompt vieta di inventare numeri e impone di dichiarare le lacune", () => {
  const sys = prompt.buildSystemPrompt("EQUITY");
  assert.match(sys, /Non inventare/);
  assert.match(sys, /dataGaps/);
  assert.match(sys, /APPROFONDIRE/, "senza dati sufficienti il verdetto ha una via d'uscita onesta");
  assert.match(sys, /non hai accesso a internet/i);
  assert.match(sys, /non dare consulenza fiscale/i);
});

test("il blocco dell'obbligazione parla di scadenzario e non pretende dati di mercato", () => {
  const bond = prompt.buildSystemPrompt("BOND");
  assert.match(bond, /SCADENZARIO/);
  assert.match(bond, /inserito a mano/);
  assert.match(bond, /duration/, "la duration si ragiona, non si calcola con questi dati");
});

// ---------------------------------------------------------------------------
// Turno utente
// ---------------------------------------------------------------------------

test("il turno utente porta il contesto in JSON, `null` compresi", () => {
  const ctx = context();
  const user = prompt.buildUserPrompt(ctx);
  assert.ok(user.includes("Acme SpA · ACME.MI · IT0001234567"));

  // Il JSON deve essere rileggibile: è il contratto tra noi e il modello.
  const json = user.slice(user.indexOf("{"));
  const parsed = JSON.parse(json);
  assert.equal(parsed.instrument.id, 7);
  assert.equal(parsed.fundamentals, null, "un dato assente resta null, non diventa 0 o ''");
  assert.equal(parsed.priceCoverage.rows, 400);
});

// ---------------------------------------------------------------------------
// Lacune calcolate da noi
// ---------------------------------------------------------------------------

test("contextGaps elenca cosa manca DAVVERO, senza fidarsi del modello", () => {
  const gaps = prompt.contextGaps(context());
  assert.ok(gaps.some((g) => g.includes("fondamentale")));
  assert.ok(gaps.some((g) => g.includes("posizione")));
  // C'è una quotazione e ci sono 400 righe di prezzi: non devono comparire.
  assert.ok(!gaps.some((g) => g.includes("nessuna quotazione")));
  assert.ok(!gaps.some((g) => g.includes("nessuno storico")));
});

test("contextGaps distingue 'provider spento' da 'strumento non coperto'", () => {
  const manual = prompt.contextGaps(context({ provider: "manual" }));
  assert.ok(manual.some((g) => g.includes("MARKET_PROVIDER=manual")));

  const yahoo = prompt.contextGaps(context({ provider: "yahoo" }));
  assert.ok(yahoo.some((g) => g.includes("provider per questo strumento")));
});

test("contextGaps segnala lo storico troppo corto per volatilità e drawdown", () => {
  const ctx = context({
    priceCoverage: { from: "2026-08-01", to: "2026-08-05", rows: 4 },
    risk: {
      points: 4,
      from: "2026-08-01",
      to: "2026-08-05",
      last: "12.5",
      spanDays: 4,
      high52w: null,
      low52w: null,
      fromHigh52w: null,
      fromLow52w: null,
      returns: [],
      volatility: null,
      maxDrawdown: null,
      sma50: null,
      sma200: null,
      trend: null,
    },
  });
  assert.ok(prompt.contextGaps(ctx).some((g) => g.includes("troppo corto")));
});

// ---------------------------------------------------------------------------
// Schema dell'output
// ---------------------------------------------------------------------------

test("lo schema JSON rispetta i limiti degli structured outputs", () => {
  // `additionalProperties: false` + `required` completo su OGNI oggetto, e nessun
  // vincolo numerico (`minimum`/`maximum`) o di lunghezza: non sono supportati, e
  // metterli farebbe fallire la richiesta con un 400 al primo utilizzo.
  const seen: string[] = [];
  const walk = (node: any, at: string) => {
    if (!node || typeof node !== "object") return;
    for (const forbidden of ["minimum", "maximum", "minLength", "maxLength", "multipleOf", "minItems", "maxItems"]) {
      assert.ok(!(forbidden in node), `${at} usa ${forbidden}, non supportato`);
    }
    if (node.type === "object") {
      seen.push(at);
      assert.equal(node.additionalProperties, false, `${at} deve vietare le proprietà extra`);
      const props = Object.keys(node.properties || {});
      assert.deepEqual([...(node.required || [])].sort(), props.sort(), `${at}: required deve elencare tutte le proprietà`);
      for (const [k, v] of Object.entries(node.properties || {})) walk(v, `${at}.${k}`);
    }
    if (node.type === "array") walk(node.items, `${at}[]`);
  };
  walk(prompt.ANALYSIS_SCHEMA, "root");
  assert.ok(seen.length >= 5, "lo schema deve descrivere anche gli oggetti annidati");
});

test("verdetto, confidenza, gravità e valutazione sono liste CHIUSE, allineate al database", () => {
  // Gli stessi valori del CHECK constraint in 004_instrument_analyses.sql: se qui si
  // aggiunge un verdetto senza migrazione, il salvataggio fallisce con un 500.
  assert.deepEqual(prompt.VERDICTS, ["COMPRARE", "MANTENERE", "RIDURRE", "EVITARE", "APPROFONDIRE"]);
  assert.deepEqual(prompt.CONFIDENCES, ["ALTA", "MEDIA", "BASSA"]);
  const props: any = prompt.ANALYSIS_SCHEMA.properties;
  assert.deepEqual([...props.verdict.enum], prompt.VERDICTS);
  assert.deepEqual([...props.confidence.enum], prompt.CONFIDENCES);
  assert.deepEqual([...props.valuation.properties.assessment.enum], prompt.VALUATIONS);
  assert.deepEqual([...props.risks.items.properties.severity.enum], prompt.SEVERITIES);
  // Il punteggio è un enum di interi PROPRIO perché minimum/maximum non esistono.
  assert.deepEqual([...props.financialHealth.properties.score.enum], [1, 2, 3, 4, 5]);
});

// ---------------------------------------------------------------------------
// Validazione dell'output (la seconda guardia)
// ---------------------------------------------------------------------------

const validPayload = {
  headline: "Bilancio solido, valutazione tirata",
  verdict: "MANTENERE",
  confidence: "MEDIA",
  summary: "Debito coperto dalla cassa, margini stabili, multipli sopra la media storica.",
  financialHealth: { score: 4, label: "solida", notes: ["debito/patrimonio 78%"] },
  valuation: { assessment: "CARA", notes: ["P/E 35,8"] },
  strengths: [{ title: "Flusso di cassa", detail: "FCF superiore all'utile netto." }],
  risks: [{ title: "Concentrazione", detail: "Pesa il 30% del portafoglio.", severity: "ALTA" }],
  positionAdvice: "Non aumentare finché il peso resta sopra il 25%.",
  watchlist: ["margine lordo del prossimo trimestre"],
  dataGaps: [],
};

test("un output conforme passa entrambe le validazioni", () => {
  assert.equal(payloadSchema.safeParse(validPayload).success, true);
  assert.equal(decisionSchema.safeParse(validPayload).success, true);
});

test("un verdetto o una gravità fuori lista vengono RESPINTI prima del database", () => {
  assert.equal(decisionSchema.safeParse({ ...validPayload, verdict: "VENDERE" }).success, false);
  assert.equal(decisionSchema.safeParse({ ...validPayload, confidence: "ALTISSIMA" }).success, false);
  assert.equal(
    payloadSchema.safeParse({
      ...validPayload,
      risks: [{ title: "x", detail: "y", severity: "CRITICA" }],
    }).success,
    false
  );
  // Un punteggio fuori scala: lo schema lo impedisce al modello, zod lo ricontrolla.
  assert.equal(
    payloadSchema.safeParse({ ...validPayload, financialHealth: { score: 9, label: "x", notes: [] } }).success,
    false
  );
  // Un titolo vuoto non è una scheda: meglio un errore che una card muta.
  assert.equal(payloadSchema.safeParse({ ...validPayload, headline: "   " }).success, false);
});

// ---------------------------------------------------------------------------
// Confine architetturale
// ---------------------------------------------------------------------------

test("ai/ non conosce database né fastify (confine architetturale)", () => {
  // `src/ai/` è un modulo di confine come `src/market/`: riceve un contesto già
  // assemblato e restituisce un risultato. Se un giorno importasse `repo/`, l'unico
  // modo di provarlo tornerebbe a essere "avere un database e una carta di credito".
  const dir = path.join(__dirname, "..", "..", "src", "ai");
  const vietati = ["pg", "../db/", "../repo/", "fastify", "../http/"];
  for (const { file, src } of readSources(dir)) {
    for (const { spec } of importsOf(src)) {
      for (const v of vietati) {
        assert.ok(!spec.includes(v), `${file} importa ${spec}, vietato in ai/`);
      }
    }
  }
});

test("prompt.ts è PURO: nessun import a runtime oltre ai moduli locali", () => {
  // I prompt devono essere calcolabili senza SDK, senza rete e senza config: è ciò
  // che permette a questo file di test di esistere.
  const dir = path.join(__dirname, "..", "..", "src", "ai");
  const file = readSources(dir).find((s) => s.file === "prompt.ts");
  assert.ok(file, "prompt.ts deve esistere");
  assert.deepEqual(runtimeImportsOf(file.src), [], "prompt.ts non deve importare nulla a runtime");
});
