// La chiamata a Claude che produce l'analisi di uno strumento.
//
// Confine: questo modulo riceve un `AnalysisContext` GIÀ ASSEMBLATO e restituisce un
// risultato validato. Non conosce il database, non conosce fastify, non decide cosa
// mettere nel contesto — così l'unica cosa che serve per provarlo è un runner finto
// (`_setClient`), e nessun test spende soldi.
//
// Il trasporto (Agent SDK, opzioni, timeout, credenziali) vive tutto in `client.ts`:
// qui restano il prompt, la lettura del risultato e la validazione.
import { z } from "zod";
import config from "../config";
import logger from "../logger";
import { AiError, createAiRunner } from "./client";
import { ANALYSIS_SCHEMA, CONFIDENCES, SEVERITIES, VALUATIONS, VERDICTS, buildSystemPrompt, buildUserPrompt } from "./prompt";
import { errMessage } from "../util/err";
import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AnalysisContext } from "./prompt";
import type { AnalysisConfidence, AnalysisPayload, AnalysisUsage, AnalysisVerdict } from "../types";

/** Lo stesso vincolo dello schema JSON, ricontrollato in casa. */
const payloadSchema = z.object({
  headline: z.string().trim().min(1),
  summary: z.string().trim().min(1),
  financialHealth: z.object({
    score: z.number().int().min(1).max(5),
    label: z.string().trim(),
    notes: z.array(z.string()).default([]),
  }),
  valuation: z.object({
    assessment: z.enum(VALUATIONS as [string, ...string[]]),
    notes: z.array(z.string()).default([]),
  }),
  strengths: z.array(z.object({ title: z.string(), detail: z.string() })).default([]),
  risks: z
    .array(
      z.object({
        title: z.string(),
        detail: z.string(),
        severity: z.enum(SEVERITIES as [string, ...string[]]),
      })
    )
    .default([]),
  positionAdvice: z.string().default(""),
  watchlist: z.array(z.string()).default([]),
  dataGaps: z.array(z.string()).default([]),
});

const decisionSchema = z.object({
  verdict: z.enum(VERDICTS as [AnalysisVerdict, ...AnalysisVerdict[]]),
  confidence: z.enum(CONFIDENCES as [AnalysisConfidence, ...AnalysisConfidence[]]),
});

export interface AnalysisResult {
  model: string;
  effort: string | null;
  verdict: AnalysisVerdict;
  confidence: AnalysisConfidence;
  headline: string;
  analysis: AnalysisPayload;
  usage: AnalysisUsage;
  /** Millisecondi impiegati: l'analisi è lenta e va misurata, non indovinata. */
  durationMs: number;
}

/**
 * Perché un `result` non riuscito è fallito, in italiano.
 *
 * I sottotipi arrivano dall'Agent SDK e sono l'unico segnale strutturato che
 * abbiamo: tradurli uno per uno evita il "Errore inatteso" che manda a leggere i
 * log per capire perché un pulsante non ha funzionato.
 */
const SUBTYPE_MESSAGE: Record<string, string> = {
  error_max_turns: "l'analisi si è fermata prima di concludere",
  error_max_budget_usd: "l'analisi ha superato il budget previsto",
  error_max_structured_output_retries: "l'analisi non rispetta il formato previsto",
  error_during_execution: "il servizio di analisi non ha risposto",
};

/**
 * Il modello che ha davvero risposto.
 *
 * `modelUsage` è indicizzato per modello: con un fallback attivo chi risponde può
 * non essere chi è stato chiesto, e si prende quello che ha prodotto più token in
 * uscita — cioè quello che ha scritto la scheda.
 */
function servedBy(result: SDKResultMessage): string | null {
  const entries = Object.entries(result.modelUsage ?? {});
  if (entries.length === 0) return null;
  return entries.sort((a, b) => (b[1]?.outputTokens ?? 0) - (a[1]?.outputTokens ?? 0))[0][0];
}

/**
 * Analizza uno strumento.
 *
 * L'output strutturato arriva in `structured_output`; `result` (il testo) è il
 * ripiego per quando l'SDK non lo popola. Si prova prima il campo tipizzato perché
 * è già un oggetto: passare dal testo significherebbe riparsare ciò che l'SDK ha
 * appena validato.
 */
async function analyzeInstrument(context: AnalysisContext): Promise<AnalysisResult> {
  const run = createAiRunner();
  const model = config.ai.model;
  const effort = config.ai.effort;
  const startedAt = Date.now();

  let result: SDKResultMessage;
  try {
    result = await run({
      system: buildSystemPrompt(context.instrument.assetClass),
      prompt: buildUserPrompt(context),
      schema: ANALYSIS_SCHEMA as unknown as Record<string, unknown>,
    });
  } catch (e) {
    // Un AiError arriva già con il suo codice e un messaggio che spiega (timeout,
    // nessun risultato): riavvolgerlo qui lo sostituirebbe con un generico "non ha
    // risposto", cioè butterebbe via l'unica cosa utile.
    if (e instanceof AiError || (e as { name?: string })?.name === "AiError") throw e;

    // Un 429 o un 5xx a monte non è un errore interno nostro: è un upstream che non
    // risponde, e la UI deve poter dire "riprova tra poco".
    const status = (e as { status?: number })?.status;
    logger.error(
      { model, status, err: errMessage(e).slice(0, 300) },
      "[ai] chiamata di analisi fallita"
    );
    throw new AiError("upstream_error", "il servizio di analisi non ha risposto", {
      status: status ?? null,
      // Il messaggio a monte viaggia SOLO per i 4xx, dove la causa è la nostra
      // richiesta (un parametro non accettato, un modello inesistente): è
      // esattamente ciò che serve vedere in pagina invece di andare a cercare nei
      // log. Sui 5xx non aggiunge nulla e sarebbe rumore. Nessun 4xx dell'API
      // rimanda indietro la credenziale: gli errori di autenticazione parlano di
      // credenziali non valide, non le citano.
      upstream:
        status !== undefined && status >= 400 && status < 500
          ? errMessage(e).slice(0, 300)
          : undefined,
      hint: status === 429 ? "limite di richieste raggiunto: riprova tra qualche minuto" : undefined,
    });
  }

  const durationMs = Date.now() - startedAt;

  // `refusal` non è un errore di trasporto: arriva con un risultato regolare e
  // `structured_output` vuoto. Leggerlo senza controllare `stop_reason` qui
  // produrrebbe un crash oscuro a valle.
  if (result.stop_reason === "refusal") {
    logger.warn({ model, subtype: result.subtype }, "[ai] analisi rifiutata dai classificatori");
    throw new AiError("upstream_error", "il modello ha rifiutato di completare l'analisi", {
      stopReason: result.stop_reason,
    });
  }
  if (result.stop_reason === "max_tokens") {
    throw new AiError("upstream_error", "analisi troncata: risposta più lunga del limite", {
      numTurns: result.num_turns,
    });
  }

  if (result.subtype !== "success" || result.is_error) {
    const status = result.subtype === "success" ? (result.api_error_status ?? null) : null;
    const errors = result.subtype === "success" ? [] : result.errors;
    logger.error(
      { model, subtype: result.subtype, status, errors: errors.slice(0, 3) },
      "[ai] analisi non completata dall'agente"
    );
    throw new AiError(
      "upstream_error",
      SUBTYPE_MESSAGE[result.subtype] ?? "il servizio di analisi non ha risposto",
      {
        status,
        subtype: result.subtype,
        upstream: errors.length ? errors.join("; ").slice(0, 300) : undefined,
        hint:
          status === 429
            ? "limite di richieste raggiunto: riprova tra qualche minuto"
            : undefined,
      }
    );
  }

  let parsed: unknown = result.structured_output;
  if (parsed === undefined || parsed === null) {
    try {
      parsed = JSON.parse(result.result);
    } catch {
      logger.error(
        { model, sample: String(result.result).slice(0, 200) },
        "[ai] risposta non è JSON valido"
      );
      throw new AiError("upstream_error", "l'analisi è tornata in un formato non leggibile");
    }
  }

  // Doppia guardia sull'output: lo schema lo impone al modello, zod lo verifica
  // qui. Senza, un campo fuori lista arriverebbe fino al CHECK constraint del
  // database, cioè a un 500 al momento del salvataggio.
  const payload = payloadSchema.safeParse(parsed);
  const decision = decisionSchema.safeParse(parsed);
  if (!payload.success || !decision.success) {
    const issues = [...(payload.error?.issues ?? []), ...(decision.error?.issues ?? [])]
      .slice(0, 5)
      .map((i) => `${i.path.join(".")}: ${i.message}`);
    logger.error({ model, issues }, "[ai] output dell'analisi non conforme allo schema");
    throw new AiError("upstream_error", "l'analisi non rispetta il formato previsto", { issues });
  }

  const usage: AnalysisUsage = {
    inputTokens: Number(result.usage?.input_tokens) || null,
    outputTokens: Number(result.usage?.output_tokens) || null,
    // Con un fallback attivo il modello che risponde può non essere quello chiesto:
    // conservarlo è l'unico modo di sapere, tra un mese, chi ha scritto la scheda.
    servedBy: servedBy(result),
  };

  logger.info(
    {
      instrumentId: context.instrument.id,
      model,
      servedBy: usage.servedBy,
      effort,
      verdict: decision.data.verdict,
      durationMs,
      numTurns: result.num_turns,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheRead: result.usage?.cache_read_input_tokens ?? null,
      costUsd: result.total_cost_usd ?? null,
    },
    "[ai] analisi completata"
  );

  return {
    model,
    effort,
    verdict: decision.data.verdict,
    confidence: decision.data.confidence,
    headline: payload.data.headline,
    analysis: payload.data as AnalysisPayload,
    usage,
    durationMs,
  };
}

export { analyzeInstrument, payloadSchema, decisionSchema, servedBy as _servedBy };
