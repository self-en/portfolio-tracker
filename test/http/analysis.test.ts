// Gli endpoint dell'analisi con Claude, contro l'app REALE (fastify + repo +
// domain) con pg-mem come database.
//
// NESSUNA CHIAMATA ALL'API VERA: il runner dell'Agent SDK viene sostituito con uno
// finto (`_setClient`). È il motivo per cui quel seam esiste — senza, l'unico modo
// di provare questo percorso sarebbe spendere soldi a ogni `npm test`, e nessuno
// eseguirebbe più i test.
//
// Il finto cattura anche l'INGRESSO della richiesta (prompt di sistema, turno
// utente, schema), mentre le opzioni della query si verificano su
// `buildQueryOptions`, che è pura. Insieme coprono le scelte che altrimenti si
// verificherebbero solo leggendo una fattura.
// Per PRIMO: imposta l'env prima che qualsiasi import carichi src/config.
import { TEST_PASSWORD } from "../helpers/env";

import test from "node:test";
import assert from "node:assert/strict";

import { freshMemDb } from "../helpers/memdb";
import { must } from "../helpers/must";
import type { FastifyInstance } from "fastify";

let server: FastifyInstance;
let base: string;
let cookie: string;
let config: typeof import("../../src/config").default;
let aiClient: typeof import("../../src/ai/client");

/** L'ultima richiesta ricevuta dal client finto. */
let captured: any = null;

const ANALYSIS = {
  headline: "Bilancio solido, valutazione tirata",
  verdict: "MANTENERE",
  confidence: "MEDIA",
  summary: "Debito coperto dalla cassa, margini stabili, multipli sopra la media storica.",
  financialHealth: { score: 4, label: "solida", notes: ["debito/patrimonio 78%"] },
  valuation: { assessment: "CARA", notes: ["P/E 35,8"] },
  strengths: [{ title: "Flusso di cassa", detail: "FCF superiore all'utile netto." }],
  risks: [{ title: "Concentrazione", detail: "Pesa troppo sul portafoglio.", severity: "ALTA" }],
  positionAdvice: "Non aumentare finché il peso resta sopra il 25%.",
  watchlist: ["margine lordo del prossimo trimestre"],
  dataGaps: ["stato patrimoniale voce per voce non pubblicato"],
};

/**
 * Un runner finto: la stessa firma di quello vero — riceve `{system, prompt, schema}`
 * e restituisce il messaggio `result` dell'Agent SDK.
 */
function fakeClient(reply: (input: any) => unknown) {
  return async (input: any) => {
    captured = input;
    return reply(input);
  };
}

/** Un `result` dell'Agent SDK, con i soli campi che il modulo legge davvero. */
const sdkResult = (over: Record<string, unknown> = {}) => ({
  type: "result",
  subtype: "success",
  is_error: false,
  stop_reason: "end_turn",
  num_turns: 1,
  total_cost_usd: 0.42,
  result: "",
  usage: { input_tokens: 4321, output_tokens: 765, cache_read_input_tokens: 4000 },
  modelUsage: { "claude-opus-5": { outputTokens: 765, inputTokens: 4321 } },
  ...over,
});

const okReply = (body: unknown = ANALYSIS) => () =>
  sdkResult({ structured_output: body, result: JSON.stringify(body) });

/**
 * Una chiamata all'API con il cookie di sessione attaccato.
 *
 * `content-type` SOLO quando c'è un corpo, esattamente come fa la SPA
 * (`web/src/api.ts`): un POST senza corpo ma con `content-type: application/json`
 * viene respinto da Fastify con un 422 prima di arrivare all'handler, e il test
 * verificherebbe un percorso che il browser non prende mai.
 */
async function api<T = any>(path: string, opts: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${base}${path}`, {
    ...opts,
    headers: {
      ...(opts.body === undefined ? {} : { "content-type": "application/json" }),
      cookie,
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body: body as T };
}

/**
 * Aspetta che il job accodato per uno strumento finisca, facendo polling della GET
 * come fa la SPA (`refetchInterval`). Il fake client risolve senza I/O reale, quindi
 * qui bastano pochi giri: se dopo `tries` la GET dice ancora `pending`, qualcosa nel
 * codice di produzione (o nel test) non fa avanzare il job, ed è meglio un errore
 * chiaro che un timeout silenzioso di `node --test`.
 */
async function waitForJob(id: number, tries = 200): Promise<{ status: number; body: any }> {
  for (let i = 0; i < tries; i += 1) {
    const r = await api(`/api/instruments/${id}/analysis`);
    if (!r.body.pending) return r;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`analisi ${id}: ancora pending dopo ${tries} tentativi`);
}

/** POST (202, accodata) seguita dal polling fino alla fine: la GET risultante porta `lastJob` e `latest`. */
async function runAnalysis(id: number): Promise<{ status: number; body: any }> {
  const started = await api(`/api/instruments/${id}/analysis`, { method: "POST" });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  assert.equal(started.body.status, "running");
  return waitForJob(id);
}

const ids: Record<string, number> = {};

test("setup: app, strumenti, ledger e prezzi", async () => {
  await freshMemDb();
  const boot = require("../../src/boot") as typeof import("../../src/boot");
  boot.state.ready = true;
  boot.state.db.connected = true;
  const { buildApp } = require("../../src/app") as typeof import("../../src/app");
  config = (require("../../src/config") as typeof import("../../src/config")).default;
  aiClient = require("../../src/ai/client") as typeof import("../../src/ai/client");

  server = await buildApp();
  base = await server.listen({ port: 0, host: "127.0.0.1" });

  const login = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: TEST_PASSWORD }),
  });
  assert.equal(login.status, 204);
  cookie = login.headers.getSetCookie()[0].split(";")[0];

  let r = await api("/api/instruments", {
    method: "POST",
    body: JSON.stringify({
      assetClass: "EQUITY",
      name: "Acme SpA",
      ticker: "ACME.MI",
      isin: "IT0001234567",
      currency: "EUR",
    }),
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  ids.eq = r.body.id;

  r = await api("/api/instruments", {
    method: "POST",
    body: JSON.stringify({
      assetClass: "BOND",
      name: "BTP 3,45% 01/07/2030",
      isin: "IT0005611741",
      currency: "EUR",
      priceSource: "manual",
      quoteConvention: "PCT_OF_NOMINAL",
      faceValue: "1000",
      couponRate: "0.0345",
      couponFrequency: 2,
      firstCouponDate: "2025-01-01",
      maturityDate: "2030-07-01",
      dayCount: "ACT/ACT-ICMA",
    }),
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  ids.bond = r.body.id;

  // Una posizione vera sull'azione: è ciò che rende il contesto "la MIA posizione".
  r = await api("/api/transactions", {
    method: "POST",
    body: JSON.stringify({
      instrumentId: ids.eq,
      type: "BUY",
      tradeDate: "2025-01-15",
      quantity: "100",
      price: "10",
      fees: "5",
    }),
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));

  for (const [date, close] of [["2025-01-15", "10"], ["2026-08-04", "12.5"]]) {
    const rr = await api(`/api/instruments/${ids.eq}/prices`, {
      method: "PUT",
      body: JSON.stringify({ date, close }),
    });
    assert.equal(rr.status, 200, JSON.stringify(rr.body));
  }
});

// ---------------------------------------------------------------------------
// Funzione non configurata: si spiega, non si rompe
// ---------------------------------------------------------------------------

test("GET senza token: risponde 200 dicendo che non è configurata", async () => {
  // Il resto dell'app funziona senza CLAUDE_CODE_OAUTH_TOKEN: la pagina deve poter
  // spiegare perché il pulsante è spento, e per farlo le serve una risposta.
  assert.equal(config.ai.configured, false, "l'ambiente di test non ha il token");
  const r = await api(`/api/instruments/${ids.eq}/analysis`);
  assert.equal(r.status, 200);
  assert.equal(r.body.configured, false);
  assert.equal(r.body.latest, null);
  assert.deepEqual(r.body.previous, []);
  assert.match(r.body.disclaimer, /non una raccomandazione di investimento/i);
  assert.equal(r.body.model, "claude-opus-5");
});

test("POST senza token: 503 ai_unavailable, NON not_configured", async () => {
  // `not_configured` nella SPA significa "l'APP non è configurata" e apre la
  // schermata di configurazione: usarlo qui manderebbe l'utente a impostare
  // APP_PASSWORD per un'analisi mancante.
  const r = await api(`/api/instruments/${ids.eq}/analysis`, { method: "POST" });
  assert.equal(r.status, 503);
  assert.equal(r.body.error.code, "ai_unavailable");
  assert.match(JSON.stringify(r.body.error.details), /CLAUDE_CODE_OAUTH_TOKEN/);
});

test("GET su uno strumento inesistente: 404", async () => {
  const r = await api("/api/instruments/999999/analysis");
  assert.equal(r.status, 404);
  assert.equal(r.body.error.code, "not_found");
});

// ---------------------------------------------------------------------------
// Percorso completo, con il client finto
// ---------------------------------------------------------------------------

test("POST accoda, e il job finisce per validare e SALVARE l'analisi", async () => {
  config.ai.configured = true;
  aiClient._setClient(fakeClient(okReply()));
  captured = null;

  const r = await runAnalysis(ids.eq);
  assert.equal(r.body.lastJob?.status, "done", JSON.stringify(r.body));

  const a = r.body.latest;
  assert.equal(a.verdict, "MANTENERE");
  assert.equal(a.confidence, "MEDIA");
  assert.equal(a.headline, ANALYSIS.headline);
  assert.equal(a.analysis.financialHealth.score, 4);
  assert.equal(a.model, "claude-opus-5");
  assert.equal(a.servedBy, "claude-opus-5");
  assert.equal(a.usage.inputTokens, 4321);
  assert.equal(a.usage.outputTokens, 765);
  assert.ok(a.id > 0, "l'analisi è stata salvata e ha un id");

  // La base del giudizio viaggia in risposta: prezzo, righe di storico, posizione.
  //
  // `String(...)`: i NUMERIC di pg-mem sono float-backed e non passano dai type
  // parser di `pg` (vedi test/helpers/memdb.ts), quindi qui arriva 12.5 dove in
  // produzione arriva "12.50000000". È un limite del mock, non del contratto: la
  // regola "numerici come stringa" è verificata dai test di dominio e sull'env di
  // branch, non da questa asserzione.
  assert.equal(String(a.basis.quotePrice), "12.5");
  assert.equal(a.basis.priceRows, 2);
  assert.equal(a.basis.hadPosition, true);
  assert.equal(a.basis.provider, "manual", "nei test il provider di mercato è spento");
  // Le lacune sono calcolate dal SERVER, non autodichiarate dal modello.
  assert.ok(a.basis.gaps.some((g: string) => g.includes("MARKET_PROVIDER=manual")));
});

test("la richiesta al modello separa prefisso stabile e dati, e vincola l'output", async () => {
  const p = must(captured, "l'ingresso catturato");

  // Output strutturato: la scheda arriva nella forma attesa, non da un testo libero.
  assert.equal(p.schema.properties.verdict.type, "string");

  // Il prompt di sistema è il prefisso STABILE: la classe sì, i dati no. Metterci
  // il nome del titolo invaliderebbe la cache a ogni analisi, in silenzio.
  assert.ok(p.system.includes("CLASSE: AZIONE"));
  assert.ok(!p.system.includes("Acme"), "i dati stanno nel turno utente, non nel prefisso");

  // Il contesto contiene davvero la posizione e il costo medio dell'utente.
  const json = JSON.parse(p.prompt.slice(p.prompt.indexOf("{")));
  assert.equal(json.instrument.name, "Acme SpA");
  assert.equal(json.position.quantity, "100.00000000");
  assert.equal(json.position.avgCost, "10.05000000", "carico medio: (1000 + 5 di commissioni) / 100");
  assert.equal(String(json.risk.last), "12.5");
  // Il massimo a 52 settimane porta SOLO data e chiusura: dentro un prompt a
  // pagamento non ha senso spedire mezzo record di prices_daily.
  assert.deepEqual(Object.keys(json.risk.high52w), ["date", "close"]);
});

test("GET restituisce l'ultima analisi; una seconda finisce nello storico", async () => {
  let r = await api(`/api/instruments/${ids.eq}/analysis`);
  assert.equal(r.status, 200);
  assert.equal(r.body.configured, true);
  assert.equal(must(r.body.latest, "l'ultima analisi").verdict, "MANTENERE");
  assert.deepEqual(r.body.previous, []);

  // Una seconda analisi non sovrascrive la prima: confrontare due giudizi a
  // distanza di mesi è il dato più interessante che questa funzione produce.
  aiClient._setClient(fakeClient(okReply({ ...ANALYSIS, verdict: "RIDURRE", headline: "Peso eccessivo" })));
  const created = await runAnalysis(ids.eq);
  assert.equal(created.body.lastJob?.status, "done", JSON.stringify(created.body));

  r = await api(`/api/instruments/${ids.eq}/analysis`);
  assert.equal(must(r.body.latest, "l'ultima analisi").verdict, "RIDURRE");
  assert.equal(r.body.previous.length, 1);
  assert.equal(r.body.previous[0].verdict, "MANTENERE");
});

test("la LISTA degli strumenti porta il verdetto dell'ultima analisi", async () => {
  const r = await api("/api/instruments");
  assert.equal(r.status, 200);
  const eq = must(
    r.body.items.find((i: any) => i.id === ids.eq),
    "lo strumento analizzato"
  );
  assert.equal(must(eq.latestAnalysis, "il verdetto in lista").verdict, "RIDURRE");
  const bond = must(
    r.body.items.find((i: any) => i.id === ids.bond),
    "lo strumento non analizzato"
  );
  assert.equal(bond.latestAnalysis, null, "chi non è stato analizzato lo dichiara");
});

// ---------------------------------------------------------------------------
// Un'obbligazione: nessun fondamentale, e va bene così
// ---------------------------------------------------------------------------

test("un bond a pricing manuale si analizza comunque, con lo scadenzario nel contesto", async () => {
  await api(`/api/instruments/${ids.bond}/prices`, {
    method: "PUT",
    body: JSON.stringify({ date: "2026-08-04", close: "101.25" }),
  });

  aiClient._setClient(fakeClient(okReply({ ...ANALYSIS, verdict: "MANTENERE", valuation: { assessment: "NON_VALUTABILE", notes: [] } })));
  captured = null;
  const r = await runAnalysis(ids.bond);
  assert.equal(r.body.lastJob?.status, "done", JSON.stringify(r.body));

  const p = must(captured, "i parametri catturati");
  assert.ok(p.system.includes("CLASSE: OBBLIGAZIONE"), "prompt dedicato alla classe");

  const json = JSON.parse(p.prompt.slice(p.prompt.indexOf("{")));
  // Number(): pg-mem restituisce i NUMERIC come float (vedi la nota sopra), in
  // produzione questo campo è la stringa "0.03450000".
  assert.equal(Number(json.bond.couponRate), 0.0345, "frazione annua, non percentuale");
  assert.ok(Array.isArray(json.couponSchedule) && json.couponSchedule.length > 0, "cedole future calcolate da noi");
  assert.equal(json.fundamentals, null, "su un BTP il provider non ha nulla, ed è la norma");
  assert.ok(json.currentYield, "rendimento corrente calcolato sul corso secco");
});

// ---------------------------------------------------------------------------
// Con i fondamentali veri del provider
// ---------------------------------------------------------------------------

test("i fondamentali del provider finiscono nel contesto e nelle basi dell'analisi", async () => {
  // L'ambiente di test usa il provider `manual` (nessuna rete): qui si sostituisce
  // il solo `getFundamentals` sul singleton, alimentandolo con la FIXTURE REALE di
  // Yahoo passata dal normalizzatore di produzione. È l'unico test che copre il
  // percorso provider → contesto → prompt con dati veri.
  const { createProvider } = require("../../src/market/provider") as typeof import("../../src/market/provider");
  const yp = require("../../src/market/yahooProvider") as typeof import("../../src/market/yahooProvider");
  const fixture = require("../fixtures/yahoo/quoteSummary-fundamentals-AAPL.json");

  const provider = createProvider();
  const original = provider.getFundamentals;
  provider.getFundamentals = async (symbol: string) => yp.normalizeFundamentals(symbol, fixture);

  try {
    aiClient._setClient(fakeClient(okReply()));
    captured = null;
    const r = await runAnalysis(ids.eq);
    assert.equal(r.body.lastJob?.status, "done", JSON.stringify(r.body));

    const p = must(captured, "i parametri catturati");
    const json = JSON.parse(p.prompt.slice(p.prompt.indexOf("{")));
    // I numeri di bilancio arrivano al modello, non un riassunto inventato a metà.
    assert.equal(json.fundamentals.balance.debtToEquity, "78.445");
    assert.equal(json.fundamentals.profile.sector, "Technology");
    assert.equal(json.fundamentals.yearly.length, 4, "il trend su quattro esercizi");
    assert.equal(json.fundamentals.analysts.recommendationKey, "buy");

    // E la lacuna "nessun fondamentale" NON compare più.
    assert.equal(r.body.latest.basis.fundamentalsAsOf, "2026-06-27");
    assert.ok(!r.body.latest.basis.gaps.some((g: string) => g.includes("nessun fondamentale")));
    // Resta invece dichiarato ciò che il provider non pubblica più.
    assert.ok(
      r.body.latest.basis.gaps.some((g: string) => g.includes("voce per voce")),
      "lo stato patrimoniale dettagliato non c'è, e va detto"
    );
  } finally {
    provider.getFundamentals = original;
  }
});

test("la posizione viene cercata nel portafoglio che DETIENE il titolo, non nel primo", async () => {
  // Con più portafogli, `loadValuation()` senza id cade sul primo: un titolo
  // comprato nel secondo produrrebbe "non lo possiedi" e un peso calcolato sul
  // totale sbagliato — un dato falso dato in pasto a una chiamata a pagamento.
  let r = await api("/api/portfolios", { method: "POST", body: JSON.stringify({ name: "Secondario" }) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const secondo = r.body.id;

  r = await api("/api/instruments", {
    method: "POST",
    body: JSON.stringify({ assetClass: "ETF", name: "Solo nel secondo", ticker: "SEC.MI", currency: "EUR" }),
  });
  assert.equal(r.status, 201);
  const soloNelSecondo = r.body.id;

  r = await api("/api/transactions", {
    method: "POST",
    body: JSON.stringify({
      portfolioId: secondo,
      instrumentId: soloNelSecondo,
      type: "BUY",
      tradeDate: "2025-05-05",
      quantity: "10",
      price: "50",
    }),
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));

  aiClient._setClient(fakeClient(okReply()));
  captured = null;
  const created = await runAnalysis(soloNelSecondo);
  assert.equal(created.body.lastJob?.status, "done", JSON.stringify(created.body));

  const p = must(captured, "i parametri catturati");
  const json = JSON.parse(p.prompt.slice(p.prompt.indexOf("{")));
  assert.equal(json.portfolio.name, "Secondario", "il portafoglio che detiene il titolo");
  assert.ok(json.position, "la posizione deve esserci");
  assert.equal(String(json.position.quantity).startsWith("10"), true);
  assert.equal(created.body.latest.basis.hadPosition, true);
});

test("le opzioni della query confinano l'agente e vincolano l'output", () => {
  const input = { system: "prompt di sistema", prompt: "dati", schema: { type: "object" } };
  const o = aiClient.buildQueryOptions(input) as any;

  // Output strutturato con il NOSTRO schema, e il nostro prompt di sistema: il
  // preset `claude_code` descrive un agente che programma, e qui non c'entra.
  assert.deepEqual(o.outputFormat, { type: "json_schema", schema: input.schema });
  assert.equal(o.systemPrompt, "prompt di sistema");
  assert.equal(o.effort, config.ai.effort);
  assert.deepEqual(o.thinking, { type: "adaptive" });

  // Le due righe che trasformano un agente di programmazione in un analista: senza
  // strumenti non tocca il filesystem del container, senza `settingSources` non si
  // carica il CLAUDE.md del repository dentro un prompt a pagamento.
  assert.deepEqual(o.tools, [], "nessuno strumento");
  assert.deepEqual(o.settingSources, [], "nessuna configurazione dal filesystem");
  assert.equal(o.persistSession, false, "niente trascrizioni su disco");
  assert.ok(o.maxTurns > 0 && o.maxTurns <= 4, "un tetto ai giri, per la bolletta");

  // La credenziale è quella di Claude Code, e una chiave API dimenticata
  // nell'ambiente NON deve poterla scavalcare.
  assert.equal(o.env.CLAUDE_CODE_OAUTH_TOKEN, config.ai.authToken);
  assert.equal("ANTHROPIC_API_KEY" in o.env, false);
  assert.equal("ANTHROPIC_AUTH_TOKEN" in o.env, false);
  assert.ok(o.env.PATH, "il sottoprocesso eredita comunque l'ambiente di base");
});

test("lo sforzo configurato arriva alla query", () => {
  const before = config.ai.effort;
  config.ai.effort = "max";
  try {
    const o = aiClient.buildQueryOptions({ system: "s", prompt: "p", schema: {} }) as any;
    assert.equal(o.effort, "max");
  } finally {
    config.ai.effort = before;
  }
});

// ---------------------------------------------------------------------------
// Errori del modello: mai un 500, mai una scheda a metà
// ---------------------------------------------------------------------------

test("un rifiuto del modello finisce nel job come errore leggibile, non un crash sull'output vuoto", async () => {
  // `refusal` arriva con un risultato regolare e senza output strutturato: leggerlo
  // senza guardare stop_reason produrrebbe un errore illeggibile.
  aiClient._setClient(
    fakeClient(() => sdkResult({ stop_reason: "refusal", result: "" }))
  );
  const r = await runAnalysis(ids.eq);
  assert.equal(r.body.lastJob?.status, "error", JSON.stringify(r.body));
  assert.equal(r.body.lastJob.error.code, "upstream_error");
  assert.match(r.body.lastJob.error.message, /rifiutato/);
});

test("un output non conforme allo schema NON viene salvato", async () => {
  const before = await api(`/api/instruments/${ids.eq}/analysis`);
  const beforeId = must(before.body.latest, "l'ultima analisi").id;

  // Verdetto fuori lista: senza la validazione arriverebbe al CHECK constraint del
  // database, cioè a un 500 dopo aver già pagato la chiamata.
  aiClient._setClient(fakeClient(okReply({ ...ANALYSIS, verdict: "VENDERE SUBITO" })));
  let r = await runAnalysis(ids.eq);
  assert.equal(r.body.lastJob?.status, "error", JSON.stringify(r.body));
  assert.match(r.body.lastJob.error.message, /formato previsto/);

  // JSON malformato nel ripiego testuale (nessun `structured_output`): stessa storia.
  aiClient._setClient(fakeClient(() => sdkResult({ result: "non sono JSON" })));
  r = await runAnalysis(ids.eq);
  assert.equal(r.body.lastJob?.status, "error", JSON.stringify(r.body));

  // Risposta troncata: si dichiara invece di salvare una scheda mutila.
  aiClient._setClient(
    fakeClient(() => sdkResult({ stop_reason: "max_tokens", result: '{"headline":' }))
  );
  r = await runAnalysis(ids.eq);
  assert.equal(r.body.lastJob?.status, "error", JSON.stringify(r.body));
  assert.match(r.body.lastJob.error.message, /troncata/);

  // L'agente si ferma senza concludere: un sottotipo di errore dell'SDK, non
  // un'eccezione. Deve diventare un messaggio che spiega, non "Errore inatteso".
  aiClient._setClient(
    fakeClient(() =>
      sdkResult({ subtype: "error_max_turns", is_error: true, errors: [], structured_output: undefined })
    )
  );
  r = await runAnalysis(ids.eq);
  assert.equal(r.body.lastJob?.status, "error", JSON.stringify(r.body));
  assert.match(r.body.lastJob.error.message, /prima di concludere/);

  const after = await api(`/api/instruments/${ids.eq}/analysis`);
  assert.equal(must(after.body.latest, "l'ultima analisi").id, beforeId, "nessun salvataggio parziale");
});

test("un errore di rete verso il provider finisce nel job con un messaggio utile", async () => {
  aiClient._setClient(
    fakeClient(() => {
      const e: Error & { status?: number } = new Error("Too Many Requests");
      e.status = 429;
      throw e;
    })
  );
  const r = await runAnalysis(ids.eq);
  assert.equal(r.body.lastJob?.status, "error", JSON.stringify(r.body));
  assert.equal(r.body.lastJob.error.code, "upstream_error");
  assert.match(JSON.stringify(r.body.lastJob.error.details), /limite di richieste/);
  // Sui 4xx il messaggio dell'upstream arriva in pagina: la causa è la NOSTRA
  // richiesta, e cercarla nei log di un'app a utente singolo è tempo perso.
  assert.match(JSON.stringify(r.body.lastJob.error.details), /Too Many Requests/);
});

test("un AiError del trasporto conserva il suo messaggio nel job, non diventa un generico", async () => {
  // Il timeout dell'analisi nasce come AiError dentro il trasporto. Riavvolgerlo
  // nel catch generico lo sostituirebbe con "non ha risposto", cioè butterebbe via
  // l'unica cosa che dice all'utente cosa fare.
  aiClient._setClient(
    fakeClient(() => {
      throw new aiClient.AiError("upstream_error", "l'analisi ha superato il tempo massimo di 180 secondi", {
        timeoutMs: 180_000,
      });
    })
  );
  const r = await runAnalysis(ids.eq);
  assert.equal(r.body.lastJob?.status, "error", JSON.stringify(r.body));
  assert.match(r.body.lastJob.error.message, /tempo massimo/);
  assert.match(JSON.stringify(r.body.lastJob.error.details), /180000/);
});

test("un 5xx del provider NON riporta il messaggio dell'upstream nel job (sarebbe rumore)", async () => {
  aiClient._setClient(
    fakeClient(() => {
      const e: Error & { status?: number } = new Error("dettagli interni del provider");
      e.status = 500;
      throw e;
    })
  );
  const r = await runAnalysis(ids.eq);
  assert.equal(r.body.lastJob?.status, "error", JSON.stringify(r.body));
  assert.ok(!JSON.stringify(r.body.lastJob.error.details).includes("dettagli interni"));
});

// ---------------------------------------------------------------------------
// Backup: un'analisi è una fotografia, e non si rigenera gratis
// ---------------------------------------------------------------------------

test("l'export contiene le analisi, e il reimport è IDEMPOTENTE", async () => {
  const dump = await api("/api/export");
  assert.equal(dump.status, 200);
  const group = must(
    dump.body.analyses.find((g: any) => g.instrumentIsin === "IT0001234567"),
    "il gruppo di analisi dell'azione"
  );
  // Conteggio relativo, non assoluto: i test che precedono generano un numero di
  // analisi che può cambiare, e un'asserzione su "esattamente 2" si romperebbe
  // aggiungendo un caso altrove invece di segnalare un problema dell'export.
  const storico = await api(`/api/instruments/${ids.eq}/analysis?history=50`);
  const attese = 1 + storico.body.previous.length;
  const verdettoCorrente = must(storico.body.latest, "l'ultima analisi").verdict;
  assert.equal(group.items.length, attese, "TUTTE le analisi dello strumento sono nel backup");
  assert.ok(attese >= 2, "il caso interessante è più di una analisi sullo stesso titolo");
  assert.ok(group.items[0].context.instrument, "lo snapshot dei dati di ingresso è conservato");
  assert.ok(group.items[0].analysis.financialHealth, "e la scheda completa");

  // Reimportare lo stesso backup non duplica: l'indice unico su
  // (instrument_id, created_at) rende l'operazione ripetibile senza danni.
  let r = await api("/api/import", { method: "POST", body: JSON.stringify(dump.body) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.imported.analyses, 0, "già presenti: nessun duplicato");

  // Un'analisi con un istante diverso è un'altra analisi, e viene importata.
  const clone = JSON.parse(JSON.stringify(dump.body));
  clone.analyses = [
    {
      instrumentIsin: "IT0001234567",
      items: [{ ...group.items[0], createdAt: "2024-01-01T00:00:00.000Z" }],
    },
  ];
  r = await api("/api/import", { method: "POST", body: JSON.stringify(clone) });
  assert.equal(r.status, 200);
  assert.equal(r.body.imported.analyses, 1);

  // Ed è finita nello storico, non in cima: è più vecchia di tutte.
  const after = await api(`/api/instruments/${ids.eq}/analysis?history=50`);
  assert.equal(after.body.previous.length, attese, "una in più nello storico");
  assert.equal(
    must(after.body.latest, "l'ultima analisi").verdict,
    verdettoCorrente,
    "importare un'analisi vecchia non cambia quale è la più recente"
  );
});

test("un'analisi non valida viene SALTATA invece di far fallire l'intero import", async () => {
  // Non basta il campo assente: un `verdict` fuori lista o una data non parsabile
  // farebbero abortire la transazione, portandosi via portafogli, movimenti e prezzi
  // già inseriti nello stesso import. Ogni caso qui deve tornare 200 con 0 analisi.
  const rotte = [
    { caso: "verdetto assente", item: { createdAt: "2023-01-01T00:00:00.000Z", model: "x", headline: "rotta" } },
    {
      caso: "verdetto fuori lista (violerebbe il CHECK)",
      item: { createdAt: "2023-01-02T00:00:00.000Z", model: "x", verdict: "BUY", confidence: "ALTA" },
    },
    {
      caso: "confidenza fuori lista",
      item: { createdAt: "2023-01-03T00:00:00.000Z", model: "x", verdict: "COMPRARE", confidence: "ALTISSIMA" },
    },
    {
      caso: "data non parsabile",
      item: { createdAt: "ieri", model: "x", verdict: "COMPRARE", confidence: "ALTA" },
    },
  ];

  for (const { caso, item } of rotte) {
    const r = await api("/api/import", {
      method: "POST",
      body: JSON.stringify({
        // Un portafoglio nello stesso dump: se la transazione abortisse, si
        // perderebbe anche lui — ed è esattamente il danno da evitare.
        portfolios: [{ name: `Prova ${caso}` }],
        analyses: [{ instrumentIsin: "IT0001234567", items: [item] }],
      }),
    });
    assert.equal(r.status, 200, `${caso}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.imported.analyses, 0, caso);
    assert.equal(r.body.imported.portfolios, 1, `${caso}: il resto dell'import è passato`);
  }
});

// ---------------------------------------------------------------------------
// Ciclo di vita
// ---------------------------------------------------------------------------

test("cancellare uno strumento cancella le sue analisi (e non viene bloccato da esse)", async () => {
  // Il 409 su DELETE difende i MOVIMENTI, che sono inseriti a mano: un'analisi si
  // rifà, quindi non deve impedire la cancellazione.
  const r = await api("/api/instruments", {
    method: "POST",
    body: JSON.stringify({ assetClass: "ETF", name: "Usa e getta", ticker: "TEMP.MI", currency: "EUR" }),
  });
  assert.equal(r.status, 201);
  const tempId = r.body.id;

  aiClient._setClient(fakeClient(okReply()));
  const created = await runAnalysis(tempId);
  assert.equal(created.body.lastJob?.status, "done", JSON.stringify(created.body));

  const del = await api(`/api/instruments/${tempId}`, { method: "DELETE" });
  assert.equal(del.status, 204, "nessun 409: le analisi non trattengono lo strumento");

  const gone = await api(`/api/instruments/${tempId}/analysis`);
  assert.equal(gone.status, 404);
});

// ---------------------------------------------------------------------------
// Il contratto async: 202 subito, `pending` mentre gira, un job per volta,
// `lastJob` consumato una sola volta
// ---------------------------------------------------------------------------

test("la POST torna 202 subito; la GET porta `pending` finché il job non finisce, e un doppio POST è un 409", async () => {
  const r = await api("/api/instruments", {
    method: "POST",
    body: JSON.stringify({ assetClass: "ETF", name: "In sospeso", ticker: "WAIT.MI", currency: "EUR" }),
  });
  assert.equal(r.status, 201);
  const id = r.body.id;

  // Un client finto che NON risponde finché non si sbloccca a mano: è l'unico modo
  // di osservare `pending: true` senza dipendere da un vero ritardo di rete.
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  aiClient._setClient(async (input: any) => {
    captured = input;
    await gate;
    return sdkResult({ structured_output: ANALYSIS, result: JSON.stringify(ANALYSIS) });
  });

  const started = await api(`/api/instruments/${id}/analysis`, { method: "POST" });
  assert.equal(started.status, 202);
  assert.deepEqual(started.body, { instrumentId: id, status: "running" });

  // Bloccato a metà: la GET lo dice, e non c'è ancora nessun esito da consumare.
  const mid = await api(`/api/instruments/${id}/analysis`);
  assert.equal(mid.body.pending, true);
  assert.equal(mid.body.lastJob, null);

  // Una seconda POST mentre la prima gira non ne accoda una seconda (sarebbe una
  // doppia chiamata a pagamento per un doppio click): 409, non 202.
  const dup = await api(`/api/instruments/${id}/analysis`, { method: "POST" });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, "conflict");

  release();
  const done = await waitForJob(id);
  assert.equal(done.body.pending, false);
  assert.equal(done.body.lastJob?.status, "done");
  assert.ok((done.body.lastJob as any).durationMs >= 0);
  assert.equal(must(done.body.latest, "l'analisi salvata dal job").verdict, ANALYSIS.verdict);

  // `lastJob` è consumato: una GET successiva non lo rivede, ma `latest` resta.
  const again = await api(`/api/instruments/${id}/analysis`);
  assert.equal(again.body.lastJob, null);
  assert.equal(again.body.pending, false);
  assert.ok(again.body.latest, "l'analisi salvata resta, non è quella a essere consumata");
});

test("teardown", async () => {
  aiClient._setClient(null);
  config.ai.configured = false;
  await server.close();
});
