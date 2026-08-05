// Tassi di cambio da Frankfurter v2, con fallback su ECB SDMX.
//
// Scritto contro la forma ARRAY della v2 — `[{date, base, quote, rate}]` — non
// contro la mappa `{rates:{…}}` della v1. Verificato in Fase 0, fixture in
// test/fixtures/fx/.
//
// L'intero backfill storico è UNA SOLA richiesta:
//   GET /v2/rates?from=<min>&to=<oggi>&base=EUR&quotes=USD,GBP,CHF
// restituisce ogni coppia × ogni data in un unico array piatto, weekend e festivi
// inclusi.
import logger from "../logger";
import config from "../config";
import { errMessage } from "../util/err";
import type { FxRecord } from "../repo/fx";
import type { DateString } from "../types";

export interface FxRange {
  from?: DateString;
  to?: DateString;
}

export interface FxProvider {
  name: string;
  getRates(quotes: readonly string[] | null | undefined, range?: FxRange): Promise<{ records: FxRecord[]; source: string }>;
  getLatest(quotes: readonly string[] | null | undefined): Promise<{ records: FxRecord[]; source: string }>;
}

const BASE = "EUR";
const TIMEOUT_MS = 15_000;

function numStr(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return String(n);
}

async function fetchJson(url: string, label: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json", "user-agent": "portfolio-tracker/1.0" },
    });
    if (!res.ok) {
      throw new Error(`${label}: HTTP ${res.status}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Normalizza la risposta v2 (array piatto). Tollera anche la forma v1 a mappa, così
 * un eventuale ritorno indietro dell'API non rompe il backfill.
 * @returns {Array<{date, base, quote, rate}>}
 */
function normalizeFrankfurter(body: unknown, base = BASE): FxRecord[] {
  const out: FxRecord[] = [];

  if (Array.isArray(body)) {
    for (const r of body) {
      const rate = numStr(r?.rate);
      if (!r?.date || !r?.quote || rate === null) continue;
      out.push({
        date: String(r.date).slice(0, 10),
        base: (r.base || base).toUpperCase(),
        quote: String(r.quote).toUpperCase(),
        rate,
      });
    }
    return out;
  }

  // Forma v1: { base, date, rates: {USD: 1.15} } oppure
  // { base, rates: { "2026-08-04": {USD: 1.15} } } per i range.
  const asMap = body as { base?: string; date?: string; rates?: Record<string, unknown> } | null;
  if (asMap && typeof asMap === "object" && asMap.rates) {
    const b = (asMap.base || base).toUpperCase();
    const entries = Object.entries(asMap.rates);
    const nested = entries.length > 0 && typeof entries[0][1] === "object";
    if (nested) {
      for (const [date, map] of entries) {
        for (const [quote, rate] of Object.entries(map as Record<string, unknown>)) {
          const r = numStr(rate);
          if (r !== null) out.push({ date: date.slice(0, 10), base: b, quote: quote.toUpperCase(), rate: r });
        }
      }
    } else {
      const date = String(asMap.date || "").slice(0, 10);
      for (const [quote, rate] of entries) {
        const r = numStr(rate);
        if (date && r !== null) out.push({ date, base: b, quote: quote.toUpperCase(), rate: r });
      }
    }
  }

  return out;
}

/** Normalizza la risposta SDMX-JSON della BCE (struttura molto più profonda). */
function normalizeEcb(body: any, quote: string): FxRecord[] {
  const out: FxRecord[] = [];
  try {
    const dataSets = body?.dataSets?.[0]?.series;
    const timeValues =
      body?.structure?.dimensions?.observation?.find((d: { id: string }) => d.id === "TIME_PERIOD")?.values || [];
    if (!dataSets) return out;
    for (const series of Object.values(dataSets) as Array<{ observations?: Record<string, unknown> }>) {
      for (const [idx, obs] of Object.entries(series.observations || {})) {
        const date = timeValues[Number(idx)]?.id;
        const rate = numStr(Array.isArray(obs) ? obs[0] : obs);
        if (date && rate !== null) out.push({ date, base: BASE, quote, rate });
      }
    }
  } catch (err) {
    logger.warn({ err: errMessage(err) }, "[fx] parsing della risposta ECB fallito");
  }
  return out;
}

function createFxProvider(cfg: typeof config = config): FxProvider {
  const baseUrl = cfg.market?.fxUrl || "https://api.frankfurter.dev/v2/rates";

  return {
    name: "frankfurter",

    /**
     * Tassi per un intervallo e per più valute in UNA richiesta.
     * @returns {Promise<{records: Array, source: string}>}
     */
    async getRates(quotes: readonly string[] | null | undefined, { from, to }: FxRange = {}) {
      const list = [...new Set((quotes || []).map((q) => String(q).toUpperCase()))].filter(
        (q) => q && q !== BASE
      );
      if (list.length === 0) return { records: [], source: "none" };

      const params = new URLSearchParams({ base: BASE, quotes: list.join(",") });
      // Senza `from` l'endpoint restituisce l'ultimo giorno pubblicato.
      const url = from
        ? `${baseUrl}?from=${from}${to ? `&to=${to}` : ""}&${params}`
        : `${baseUrl}?${params}`;

      try {
        const body = await fetchJson(url, "frankfurter");
        const records = normalizeFrankfurter(body);
        if (records.length > 0) return { records, source: "frankfurter" };
        logger.warn({ url }, "[fx] Frankfurter ha risposto senza tassi utilizzabili");
      } catch (err) {
        logger.warn({ err: errMessage(err) }, "[fx] Frankfurter non raggiungibile, provo la BCE");
      }

      // Fallback ECB SDMX. I tassi storici NON cambiano mai, quindi una volta in
      // cache un'interruzione di Frankfurter tocca solo *oggi*.
      const all: FxRecord[] = [];
      for (const quote of list) {
        try {
          const url2 =
            `https://data-api.ecb.europa.eu/service/data/EXR/D.${quote}.EUR.SP00.A` +
            `?format=jsondata${from ? `&startPeriod=${from}` : ""}${to ? `&endPeriod=${to}` : ""}`;
          const body = await fetchJson(url2, `ecb ${quote}`);
          all.push(...normalizeEcb(body, quote));
        } catch (err) {
          logger.warn({ quote, err: errMessage(err) }, "[fx] fallback BCE fallito");
        }
      }
      if (all.length > 0) return { records: all, source: "ecb" };
      return { records: [], source: "none" };
    },

    async getLatest(quotes: readonly string[] | null | undefined) {
      return this.getRates(quotes, {});
    },
  };
}

export { createFxProvider, normalizeFrankfurter, normalizeEcb, BASE };
