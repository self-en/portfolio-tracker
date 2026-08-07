// Trasporto verso Claude, via Agent SDK. Costruzione, errori tipizzati, seam per i test.
//
// `src/ai/` è un modulo di CONFINE come `src/market/`: parla con un servizio
// esterno e non conosce né il database né fastify. Per questo NON importa
// `http/errors`: solleva i propri errori con un `code`, ed è il layer HTTP a
// tradurli in una risposta (esattamente come `UpstreamUnavailable` in market/).
//
// PERCHÉ L'AGENT SDK E NON `@anthropic-ai/sdk`: la credenziale che questo
// deployment possiede è `CLAUDE_CODE_OAUTH_TOKEN`, cioè il token di Claude Code.
// Puntato direttamente su /v1/messages quel token viene accettato ma consuma i
// limiti dell'abbonamento, non quelli di una chiave API: il risultato erano 429
// su ogni analisi (`rate_limit_error`), identici su dev e su main. L'Agent SDK è
// il consumatore per cui quel token è pensato, e lo gestisce lui.
//
// Il caricamento è LAZY di proposito, come per yahoo-finance2: senza il token il
// modulo non viene nemmeno caricato. Qui pesa più che altrove — l'Agent SDK porta
// con sé l'eseguibile di Claude Code (~280 MB), che senza analisi non si tocca.
//
// `import()` e non `require()`: il pacchetto è solo-ESM (`main: sdk.mjs`). Con
// `module: nodenext` TypeScript preserva l'import dinamico anche emettendo
// CommonJS, ed è l'unico modo di caricarlo da questo build.
import config from "../config";
import logger from "../logger";
import type { EffortLevel, Options, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";

/**
 * Un errore dell'analisi, con il codice che il layer HTTP userà così com'è.
 *
 * `ai_unavailable` (503) è distinto da `not_configured`: quest'ultimo, nella SPA,
 * significa "l'APP non è configurata" e apre la schermata di configurazione. Qui
 * l'app funziona: è la sola analisi a non essere disponibile.
 */
class AiError extends Error {
  readonly code: "ai_unavailable" | "upstream_error";
  readonly details: unknown;

  constructor(code: "ai_unavailable" | "upstream_error", message: string, details?: unknown) {
    super(message);
    this.name = "AiError";
    this.code = code;
    this.details = details;
  }
}

const disabled = (): AiError =>
  new AiError("ai_unavailable", "l'analisi con Claude non è configurata", {
    hint: "imposta CLAUDE_CODE_OAUTH_TOKEN dalla pagina Configurazione del progetto",
  });

/** Tutto ciò che il trasporto deve sapere: il resto lo decide `instrumentAnalysis`. */
export interface AiRunInput {
  /** Prompt di sistema già montato per la classe di attivo (prefisso stabile). */
  system: string;
  /** Il turno utente: i dati dello strumento. */
  prompt: string;
  /** Lo schema JSON che l'output deve rispettare. */
  schema: Record<string, unknown>;
}

/** Il seam: una funzione, non un oggetto client. I test ne sostituiscono una finta. */
export type AiRunner = (input: AiRunInput) => Promise<SDKResultMessage>;

/**
 * L'ambiente del sottoprocesso.
 *
 * `env` SOSTITUISCE l'ambiente invece di fondersi con esso (lo dice il tipo
 * dell'SDK): senza lo spread di `process.env` il sottoprocesso perderebbe PATH e
 * HOME e non partirebbe affatto.
 *
 * Le due `delete` non sono paranoia. Se nell'ambiente resta una chiave API
 * dimenticata nel Secret, il CLI la preferisce al token OAuth: le analisi
 * verrebbero addebitate su un altro account — o fallirebbero con un errore di
 * credenziali che non dice che il problema è averne due. Cancellarle qui rende
 * innocua una chiave di troppo, ed è l'erede diretta dell'`apiKey: null` che
 * serviva al client HTTP.
 */
function subprocessEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    CLAUDE_CODE_OAUTH_TOKEN: config.ai.authToken,
    // Identifica l'app nello User-Agent: se un giorno queste chiamate vanno
    // indagate lato Anthropic, si distinguono da Claude Code interattivo.
    CLAUDE_AGENT_SDK_CLIENT_APP: `${config.repoName}/analysis`,
  };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  return env;
}

/**
 * Le opzioni della query. FUNZIONE PURA: è qui che vivono le scelte che altrimenti
 * si verificherebbero solo leggendo una fattura, quindi dev'essere provabile senza
 * chiamare niente.
 *
 * `tools: []` e `settingSources: []` sono le due righe che trasformano un agente
 * di programmazione in un analista di bilanci: senza la prima l'agente potrebbe
 * leggere e scrivere file del container, senza la seconda si caricherebbe il
 * CLAUDE.md del repository dentro un prompt che deve parlare solo di finanza —
 * pagandolo, e sbilanciando l'analisi.
 */
function buildQueryOptions(input: AiRunInput, abort?: AbortController): Options {
  return {
    model: config.ai.model,
    // Prompt di sistema NOSTRO, non il preset `claude_code`: quello descrive un
    // agente che programma, e qui non c'entra nulla.
    systemPrompt: input.system,
    // Output strutturato: la scheda arriva già nella forma che il database e la
    // pagina si aspettano, senza estrarre campi da un testo libero.
    outputFormat: { type: "json_schema", schema: input.schema },
    effort: config.ai.effort as EffortLevel,
    // Thinking adattivo DICHIARATO invece che lasciato al default: su un modello
    // impostato da configurazione ometterlo significherebbe analizzare un bilancio
    // senza ragionare.
    thinking: { type: "adaptive" },
    // Nessuno strumento: l'analisi lavora sui dati che le passiamo nel prompt.
    // Toglie anche ogni motivo per cui il ciclo dell'agente possa allungarsi.
    tools: [],
    settingSources: [],
    // Senza strumenti non c'è nulla da autorizzare, ma un default che chiede
    // permesso su un server senza terminale sarebbe un blocco silenzioso.
    permissionMode: "dontAsk",
    // Niente trascrizioni su disco: il container è effimero e l'analisi è già
    // salvata in database, con il contesto completo.
    persistSession: false,
    // Rete di sicurezza sulla BOLLETTA: senza strumenti un turno solo basta, e i
    // ritentativi dell'output strutturato ne consumano al massimo un paio.
    maxTurns: 4,
    abortController: abort,
    env: subprocessEnv(),
    // Lo stderr del sottoprocesso non è un errore dell'app: a `debug` per non
    // sporcare i log, ma disponibile quando un'analisi fallisce senza spiegazioni.
    stderr: (data: string) =>
      logger.debug({ data: data.slice(0, 500) }, "[ai] stderr del sottoprocesso"),
  };
}

let cached: AiRunner | null = null;

/**
 * Esegue una query e restituisce il messaggio finale.
 *
 * Il timeout è un `AbortController`, non un'opzione del client: l'Agent SDK
 * governa un sottoprocesso, e l'unico modo di fermarlo è annullare la query.
 * `unref()` sul timer perché tre minuti di attesa non devono tenere in piedi il
 * processo se nel frattempo il server si sta spegnendo.
 *
 * Si consuma l'iteratore fino in fondo tenendo l'ULTIMO messaggio `result`: è
 * quello che porta output strutturato, uso dei token e motivo di arresto.
 */
async function runViaAgentSdk(input: AiRunInput): Promise<SDKResultMessage> {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), config.ai.timeoutMs);
  timer.unref?.();

  try {
    let result: SDKResultMessage | null = null;
    for await (const message of query({
      prompt: input.prompt,
      options: buildQueryOptions(input, abort),
    })) {
      if (message.type === "result") result = message;
    }
    if (!result) {
      throw new AiError("upstream_error", "l'analisi è terminata senza produrre un risultato");
    }
    return result;
  } catch (e) {
    // Un annullamento è il NOSTRO timeout, non un guasto del servizio: dirlo
    // cambia cosa fa l'utente (riprovare subito non serve, l'analisi era lunga).
    if (abort.signal.aborted) {
      throw new AiError(
        "upstream_error",
        `l'analisi ha superato il tempo massimo di ${Math.round(config.ai.timeoutMs / 1000)} secondi`,
        { timeoutMs: config.ai.timeoutMs, hint: "riprova, oppure abbassa ANALYSIS_EFFORT" }
      );
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Il runner, costruito una volta.
 *
 * Non c'è un client da tenere in cache come prima — ogni query è un sottoprocesso
 * a sé — ma la variabile resta perché è il punto in cui i test si innestano.
 */
function createAiRunner(): AiRunner {
  if (cached) return cached;
  if (!config.ai.configured) throw disabled();

  cached = runViaAgentSdk;
  logger.info(
    { model: config.ai.model, effort: config.ai.effort, timeoutMs: config.ai.timeoutMs },
    "[ai] analisi con Claude Agent SDK pronta"
  );
  return cached;
}

/** true se l'analisi è utilizzabile: la UI lo usa per spiegare invece di fallire. */
const isConfigured = (): boolean => !!config.ai.configured;

/**
 * Sostituisce il runner. SOLO PER I TEST: nessun test deve poter chiamare l'API
 * vera, e senza questo seam l'unico modo di provare gli endpoint sarebbe spendere
 * soldi a ogni `npm test`.
 */
function _setClient(fake: unknown): void {
  cached = fake as AiRunner | null;
}

export { createAiRunner, buildQueryOptions, isConfigured, AiError, disabled, _setClient };
