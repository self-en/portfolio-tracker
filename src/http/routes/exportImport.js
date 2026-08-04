// Export/import JSON.
//
// NON SONO OPZIONALI: il database del branch viene DISTRUTTO se il branch viene
// cancellato, quindi l'export è l'unica rete di sicurezza per dati inseriti a mano
// (docs/decisions.md §10).
//
// I prezzi e i cambi NON vengono esportati per default: sono rigenerabili dai
// provider, e includerli farebbe un dump da megabyte per proteggere dati che non
// sono preziosi. Ciò che è irreparabile sono strumenti e movimenti.
const express = require("express");
const logger = require("../../logger");
const { runImport } = require("../../repo/importer");
const portfoliosRepo = require("../../repo/portfolios");
const instrumentsRepo = require("../../repo/instruments");
const txRepo = require("../../repo/transactions");
const eventsRepo = require("../../repo/events");
const pricesRepo = require("../../repo/prices");
const { asyncHandler, validation, conflict } = require("../errors");
const { z, body, query } = require("../validate");

const router = express.Router();

const FORMAT_VERSION = 1;

router.get(
  "/export",
  query(
    z.object({
      includePrices: z
        .enum(["true", "false"])
        .transform((v) => v === "true")
        .optional(),
    })
  ),
  asyncHandler(async (req, res) => {
    const includePrices = !!req.valid.query.includePrices;

    const portfolios = await portfoliosRepo.list();
    const instruments = await instrumentsRepo.list();
    const transactions = await txRepo.ledger({});
    // Solo gli eventi con dato umano dentro: i PROJECTED si rigenerano dallo
    // scadenzario, quindi esportarli sarebbe rumore.
    const events = (await eventsRepo.list({})).filter(
      (e) => e.status !== "PROJECTED" || e.transactionId
    );

    const dump = {
      format: "portfolio-tracker",
      version: FORMAT_VERSION,
      exportedAt: new Date().toISOString(),
      // I prezzi manuali SÌ, sempre: per le obbligazioni sono l'unico dato che
      // esiste e non sono rigenerabili da nessun provider.
      note:
        "I prezzi manuali sono sempre inclusi (non rigenerabili). Le quotazioni automatiche e i cambi si riscaricano dai provider.",
      portfolios,
      instruments,
      transactions,
      events: events.map((e) => ({ ...e, instrument: undefined })),
      manualPrices: [],
    };

    for (const inst of instruments) {
      const series = await pricesRepo.series(inst.id);
      const manual = series.filter((p) => p.source === "manual");
      if (manual.length) {
        dump.manualPrices.push({
          instrumentIsin: inst.isin,
          instrumentTicker: inst.ticker,
          prices: manual.map((p) => ({ date: p.date, close: p.close })),
        });
      }
      if (includePrices) {
        dump.prices = dump.prices || [];
        dump.prices.push({
          instrumentIsin: inst.isin,
          instrumentTicker: inst.ticker,
          bars: series.map((p) => ({ date: p.date, close: p.close, source: p.source })),
        });
      }
    }

    res.set(
      "Content-Disposition",
      `attachment; filename="portfolio-tracker-${new Date().toISOString().slice(0, 10)}.json"`
    );
    return res.json(dump);
  })
);

const importBody = z.object({
  format: z.literal("portfolio-tracker").optional(),
  version: z.number().optional(),
  portfolios: z.array(z.record(z.string(), z.unknown())).default([]),
  instruments: z.array(z.record(z.string(), z.unknown())).default([]),
  transactions: z.array(z.record(z.string(), z.unknown())).default([]),
  events: z.array(z.record(z.string(), z.unknown())).default([]),
  manualPrices: z.array(z.record(z.string(), z.unknown())).default([]),
  // Senza `replace: true` l'import è ADDITIVO e non distrugge nulla: il default
  // sicuro è quello che non perde dati.
  replace: z.boolean().default(false),
});

router.post(
  "/import",
  body(importBody),
  asyncHandler(async (req, res) => {
    const dump = req.valid.body;
    if (dump.version && dump.version > FORMAT_VERSION) {
      throw validation(
        `formato versione ${dump.version} non supportato (questa app legge fino alla ${FORMAT_VERSION})`
      );
    }

    const stats = { portfolios: 0, instruments: 0, transactions: 0, events: 0, manualPrices: 0, skipped: [] };

    // Tutto in UNA transazione: un import a metà lascerebbe movimenti orfani, che
    // è peggio di un import fallito. L'SQL vive in repo/importer.js; qui resta solo
    // la RIMAPPATURA degli id, che è la parte con la logica.
    await runImport(async (db) => {
      if (dump.replace) {
        await db.wipe();
        logger.warn("[import] modalità replace: dati esistenti eliminati");
      }

      // Portafogli: la chiave stabile è il NOME, perché gli id del dump non
      // sopravvivono a un database ricreato.
      const portfolioIdByName = new Map(
        (await db.listPortfolioNames()).map((p) => [p.name, p.id])
      );
      for (const p of dump.portfolios) {
        if (!p.name || portfolioIdByName.has(p.name)) continue;
        portfolioIdByName.set(p.name, await db.insertPortfolio(p));
        stats.portfolios += 1;
      }

      // Strumenti: chiave stabile ISIN, altrimenti ticker.
      const instrumentIdByKey = await db.instrumentKeys();
      const oldToNewInstrument = new Map();
      for (const i of dump.instruments) {
        const key = i.isin ? `isin:${i.isin}` : i.ticker ? `ticker:${i.ticker}` : null;
        if (!key) {
          stats.skipped.push({ kind: "instrument", reason: "senza ISIN né ticker", name: i.name });
          continue;
        }
        let id = instrumentIdByKey.get(key);
        if (!id) {
          id = await db.insertInstrument(i);
          instrumentIdByKey.set(key, id);
          stats.instruments += 1;
        }
        if (i.id != null) oldToNewInstrument.set(Number(i.id), id);
      }

      // Movimenti: si rimappano gli id di strumento e portafoglio.
      const defaultPortfolioId = [...portfolioIdByName.values()][0];
      for (const t of dump.transactions) {
        const instrumentId =
          t.instrumentId == null ? null : oldToNewInstrument.get(Number(t.instrumentId)) ?? null;
        if (t.instrumentId != null && instrumentId == null) {
          stats.skipped.push({ kind: "transaction", reason: "strumento non risolto", id: t.id });
          continue;
        }
        await db.insertTransaction(defaultPortfolioId, instrumentId, t);
        stats.transactions += 1;
      }

      // Prezzi manuali: per le obbligazioni sono l'unico dato che nessun provider
      // può rigenerare.
      for (const group of dump.manualPrices) {
        const key = group.instrumentIsin
          ? `isin:${group.instrumentIsin}`
          : `ticker:${group.instrumentTicker}`;
        const id = instrumentIdByKey.get(key);
        if (!id) continue;
        for (const pr of group.prices || []) {
          await db.insertManualPrice(id, pr.date, pr.close);
          stats.manualPrices += 1;
        }
      }
    });

    // Le cedole proiettate si RIGENERANO invece di essere importate: sono derivate.
    const { regenerateProjected } = require("./instruments");
    for (const inst of await instrumentsRepo.list({ assetClass: "BOND" })) {
      await regenerateProjected(inst);
    }

    logger.info(stats, "[import] import completato");
    return res.json({ imported: stats });
  })
);

module.exports = { router, FORMAT_VERSION };
