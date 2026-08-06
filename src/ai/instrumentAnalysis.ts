// La chiamata a Claude che produce l'analisi di uno strumento.
//
// Confine: questo modulo riceve un `AnalysisContext` GIÀ ASSEMBLATO e restituisce un
// risultato validato. Non conosce il database, non conosce fastify, non decide cosa
// mettere nel contesto — così l'unica cosa che serve per provarlo è un client finto
// (`_setClient`), e nessun test spende soldi.
import { z } from "zod";
import config from "../config";
import logger from "../logger";
import { AiError, createAiClient } from "./client";
import { ANALYSIS_SCHEMA, CONFIDENCES, SEVERITIES, VALUATIONS, VERDICTS, buildSystemPrompt, buildUserPrompt } from "./prompt";
import { errMessage } from "../util/err";
import type { AnalysisContext } from "./prompt";
import type { AnalysisConfidence, AnalysisPayload, AnalysisUsage, AnalysisVerdict } from "../types";

/**
 * `max_tokens` è un tetto su PENSIERO + RISPOSTA, non solo sulla risposta: con il
 * thinking adattivo attivo un valore stretto tronca l'analisi a metà. 16.000 è il
 * limite oltre il quale una richiesta NON in streaming rischia il timeout HTTP del
 * SDK, ed è abbondante per una scheda di questa dimensione.
 */
const MAX_TOKENS = 16_000;

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

/** Il testo di tutti i blocchi `text` della risposta, concatenato. */
function textOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((b: any) => b?.type === "text" && typeof b.text === "string")
    .map((b: any) => b.text)
    .join("");
}

/**
 * Analizza uno strumento.
 *
 * Perché l'endpoint BETA e non `client.messages.create`: serve il parametro
 * `fallbacks`. I classificatori di sicurezza possono declinare una richiesta
 * (`stop_reason: "refusal"` con HTTP 200, non un errore), e su un'analisi
 * finanziaria capita per falso positivo. Con `fallbacks: "default"` la richiesta
 * viene rieseguita lato server sul modello di ripiego consigliato, così un falso
 * positivo non diventa un pulsante che non funziona.
 */
async function analyzeInstrument(context: AnalysisContext): Promise<AnalysisResult> {
  const client = createAiClient();
  const model = config.ai.model;
  const effort = config.ai.effort;
  const startedAt = Date.now();

  let response: any;
  try {
    response = await client.beta.messages.create({
      model,
      max_tokens: MAX_TOKENS,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      // Thinking adattivo DICHIARATO invece che lasciato al default: sul modello
      // predefinito è già attivo, ma su un modello impostato da configurazione
      // ometterlo significherebbe analizzare un bilancio senza ragionare.
      thinking: { type: "adaptive" },
      output_config: {
        effort: effort as "low" | "medium" | "high" | "xhigh" | "max",
        // Output strutturato: la scheda arriva già nella forma che il database e la
        // pagina si aspettano, senza estrarre campi da un testo libero.
        format: { type: "json_schema", schema: ANALYSIS_SCHEMA as unknown as Record<string, unknown> },
      },
      system: [
        {
          type: "text",
          text: buildSystemPrompt(context.instrument.assetClass),
          // Il prefisso è identico per tutti gli strumenti della stessa classe:
          // dalla seconda analisi in poi si paga a tariffa di lettura.
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: buildUserPrompt(context) }],
    });
  } catch (e) {
    // Un 429 o un 5xx del provider non è un errore interno nostro: è un upstream
    // che non risponde, e la UI deve poter dire "riprova tra poco".
    const status = (e as { status?: number })?.status;
    logger.error(
      { model, status, err: errMessage(e).slice(0, 300) },
      "[ai] chiamata di analisi fallita"
    );
    throw new AiError("upstream_error", "il servizio di analisi non ha risposto", {
      status: status ?? null,
      // Il messaggio dell'upstream viaggia SOLO per i 4xx, dove la causa è la nostra
      // richiesta (un parametro non accettato, un modello inesistente): è
      // esattamente ciò che serve vedere in pagina invece di andare a cercare nei
      // log. Sui 5xx non aggiunge nulla e sarebbe rumore. Nessun 4xx dell'API
      // rimanda indietro la chiave: gli errori di autenticazione parlano di
      // credenziali non valide, non le citano.
      upstream:
        status !== undefined && status >= 400 && status < 500
          ? errMessage(e).slice(0, 300)
          : undefined,
      hint: status === 429 ? "limite di richieste raggiunto: riprova tra qualche minuto" : undefined,
    });
  }

  const durationMs = Date.now() - startedAt;

  // `refusal` arriva con HTTP 200 e `content` vuoto o parziale: leggere
  // `content[0]` senza controllare `stop_reason` qui produrrebbe un crash oscuro.
  if (response?.stop_reason === "refusal") {
    logger.warn(
      { model, category: response?.stop_details?.category ?? null },
      "[ai] analisi rifiutata dai classificatori"
    );
    throw new AiError("upstream_error", "il modello ha rifiutato di completare l'analisi", {
      category: response?.stop_details?.category ?? null,
    });
  }
  if (response?.stop_reason === "max_tokens") {
    throw new AiError("upstream_error", "analisi troncata: risposta più lunga del limite", {
      maxTokens: MAX_TOKENS,
    });
  }

  const raw = textOf(response?.content);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    logger.error({ model, sample: raw.slice(0, 200) }, "[ai] risposta non è JSON valido");
    throw new AiError("upstream_error", "l'analisi è tornata in un formato non leggibile");
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
    inputTokens: Number(response?.usage?.input_tokens) || null,
    outputTokens: Number(response?.usage?.output_tokens) || null,
    // Con un fallback attivo il modello che risponde può non essere quello chiesto:
    // conservarlo è l'unico modo di sapere, tra un mese, chi ha scritto la scheda.
    servedBy: response?.model ?? null,
  };

  logger.info(
    {
      instrumentId: context.instrument.id,
      model,
      servedBy: usage.servedBy,
      effort,
      verdict: decision.data.verdict,
      durationMs,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheRead: response?.usage?.cache_read_input_tokens ?? null,
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

export { analyzeInstrument, MAX_TOKENS, payloadSchema, decisionSchema };
