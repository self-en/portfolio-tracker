// Client Anthropic: costruzione, errori tipizzati, seam per i test.
//
// `src/ai/` è un modulo di CONFINE come `src/market/`: parla con un servizio
// esterno e non conosce né il database né fastify. Per questo NON importa
// `http/errors`: solleva i propri errori con un `code`, ed è il layer HTTP a
// tradurli in una risposta (esattamente come `UpstreamUnavailable` in market/).
//
// Il `require` è LAZY di proposito, come per yahoo-finance2: senza chiave API il
// modulo non viene nemmeno caricato, e su un pod da poche centinaia di megabyte non
// pagare un SDK che non si usa è una scelta, non un dettaglio.
import config from "../config";
import logger from "../logger";
import type Anthropic from "@anthropic-ai/sdk";

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
    hint: "imposta ANTHROPIC_API_KEY dalla pagina Configurazione del progetto",
  });

let cached: Anthropic | null = null;

/**
 * Il client, costruito una volta.
 *
 * `timeout` è in MILLISECONDI nel SDK TypeScript (in quello Python sono secondi):
 * scambiarli darebbe un timeout di 3 minuti dove ne servono 180.000, cioè un
 * troncamento a metà analisi con un errore che non spiega niente.
 *
 * `maxRetries: 1`: il default del SDK è 2 e ogni ritentativo è un'analisi INTERA
 * pagata di nuovo. Un 429 vale un secondo tentativo, non tre.
 */
function createAiClient(): Anthropic {
  if (cached) return cached;
  if (!config.ai.configured) throw disabled();

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require("@anthropic-ai/sdk") as { default: typeof Anthropic };
  const Ctor = mod.default;
  cached = new Ctor({
    apiKey: config.ai.apiKey,
    timeout: config.ai.timeoutMs,
    maxRetries: 1,
  });
  logger.info(
    { model: config.ai.model, effort: config.ai.effort, timeoutMs: config.ai.timeoutMs },
    "[ai] client Anthropic pronto"
  );
  return cached;
}

/** true se l'analisi è utilizzabile: la UI lo usa per spiegare invece di fallire. */
const isConfigured = (): boolean => !!config.ai.configured;

/**
 * Sostituisce il client. SOLO PER I TEST: nessun test deve poter chiamare l'API
 * vera, e senza questo seam l'unico modo di provare gli endpoint sarebbe spendere
 * soldi a ogni `npm test`.
 */
function _setClient(fake: unknown): void {
  cached = fake as Anthropic | null;
}

export { createAiClient, isConfigured, AiError, disabled, _setClient };
