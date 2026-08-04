const express = require("express");
const txRepo = require("../../repo/transactions");
const instrumentsRepo = require("../../repo/instruments");
const portfoliosRepo = require("../../repo/portfolios");
const fxRepo = require("../../repo/fx");
const { computeAmounts } = require("../../domain/txAmounts");
const positions = require("../../domain/positions");
const { money, qty: fmtQty, d } = require("../../domain/money");
const { asyncHandler, notFound, validation } = require("../errors");
const { z, body, query, params, parse, idParam } = require("../validate");
const schemas = require("../schemas");

const router = express.Router();

/**
 * Prepara il record da persistere: risolve portafoglio, strumento e cambio, poi
 * calcola gli importi derivati.
 *
 * Il CALCOLO STA QUI, lato server, non in React: è la stessa funzione che alimenta
 * /preview, quindi ciò che l'utente vede nell'anteprima è esattamente ciò che verrà
 * scritto.
 */
async function prepare(input) {
  const portfolioId = input.portfolioId || (await portfoliosRepo.first())?.id;
  if (!portfolioId) throw validation("nessun portafoglio disponibile");

  let instrument = null;
  if (input.instrumentId) {
    instrument = await instrumentsRepo.byId(input.instrumentId);
    if (!instrument) throw notFound("strumento non trovato");
  }

  // Valuta: quella dello strumento se non specificata, così l'utente non deve
  // ripeterla su ogni movimento.
  const tradeCcy = input.tradeCcy || instrument?.currency || "EUR";

  // Cambio: quello indicato, altrimenti dalla cache alla data dell'operazione.
  let fxRate = input.fxRate ?? null;
  let fxSource = fxRate ? "input" : null;
  if (!fxRate && tradeCcy !== "EUR") {
    const cached = await fxRepo.rateAsOf(tradeCcy, input.tradeDate);
    if (cached) {
      fxRate = cached.rate;
      fxSource = `cache:${cached.date}`;
    }
  }
  if (tradeCcy === "EUR") {
    fxRate = "1";
    fxSource = "base";
  }

  const amounts = computeAmounts({ ...input, tradeCcy }, instrument);

  const record = {
    portfolioId,
    instrumentId: input.instrumentId ?? null,
    type: input.type,
    tradeDate: input.tradeDate,
    settleDate: input.settleDate ?? null,
    quantity: amounts.quantity,
    price: input.price ?? null,
    grossAmount: amounts.grossAmount,
    fees: input.fees ?? "0",
    taxes: input.taxes ?? "0",
    accruedInterest: amounts.accruedInterest,
    netAmount: amounts.netAmount,
    tradeCcy,
    fxRate,
    splitRatio: input.splitRatio ?? null,
    note: input.note ?? null,
    externalRef: input.externalRef ?? null,
  };

  const warnings = [...amounts.warnings];
  if (tradeCcy !== "EUR" && !fxRate) {
    warnings.push({
      code: "fx_missing",
      message: `nessun cambio EUR/${tradeCcy} in cache al ${input.tradeDate}: inserisci il tasso a mano`,
    });
  }

  return { record, instrument, amounts, warnings, fxSource };
}

router.get(
  "/",
  query(schemas.listTransactionsQuery),
  asyncHandler(async (req, res) => {
    const page = await txRepo.list(req.valid.query);
    return res.json(page);
  })
);

/**
 * Anteprima: NESSUNA SCRITTURA. Restituisce gli importi derivati e la posizione
 * risultante.
 *
 * È ciò che rende il form affidabile: l'utente vede la conseguenza prima di
 * confermare, e il calcolo del rateo vive lato server invece di essere duplicato
 * in React.
 */
router.post(
  "/preview",
  body(schemas.previewTransaction),
  asyncHandler(async (req, res) => {
    const input = req.valid.body;
    const { record, instrument, amounts, warnings, fxSource } = await prepare(input);

    let resultingPosition = null;
    if (record.instrumentId) {
      // Ledger esistente + la transazione ipotetica: la posizione risultante è
      // calcolata, non stimata.
      const existing = await txRepo.ledger({
        portfolioId: record.portfolioId,
        instrumentId: record.instrumentId,
      });
      const instruments = new Map([[instrument.id, instrument]]);
      // Id sentinella: deve ordinarsi DOPO qualsiasi transazione dello stesso
      // giorno, perché è l'operazione che l'utente sta per aggiungere.
      const PENDING_ID = Number.MAX_SAFE_INTEGER;
      const before = positions.buildPositions(existing, { instruments });
      const after = positions.buildPositions([...existing, { ...record, id: PENDING_ID }], {
        instruments,
      });

      const b = before.positions.get(instrument.id);
      const a = after.positions.get(instrument.id);
      resultingPosition = {
        quantityBefore: b ? fmtQty(b.quantity) : "0.00000000",
        quantityAfter: a ? fmtQty(a.quantity) : "0.00000000",
        costBasisBefore: b ? money(b.costBasis) : "0.000000",
        costBasisAfter: a ? money(a.costBasis) : "0.000000",
        avgCostAfter: a && !a.quantity.isZero() ? money(a.costBasis.div(a.quantity)) : null,
        realizedPnlDelta: money(
          (a ? a.realizedPnl : d(0)).minus(b ? b.realizedPnl : d(0))
        ),
      };
      // I warning del ricalcolo (oversell in primis) devono comparire NELL'ANTEPRIMA,
      // non dopo il salvataggio: è metà del valore di questo endpoint.
      for (const w of after.warnings) {
        if (before.warnings.some((x) => x.code === w.code && x.txId === w.txId)) continue;
        // L'id sentinella è un dettaglio interno: non deve finire nella risposta.
        // `pending: true` dice al form che il warning riguarda l'operazione in corso.
        const { txId, ...rest } = w;
        warnings.push(txId === PENDING_ID ? { ...rest, pending: true } : w);
      }
    }

    return res.json({
      grossAmount: record.grossAmount,
      netAmount: record.netAmount,
      accruedInterest: record.accruedInterest,
      accruedAuto: amounts.autoAccrued,
      quantity: record.quantity,
      nominal: amounts.nominal,
      fxRate: record.fxRate,
      fxSource,
      tradeCcy: record.tradeCcy,
      resultingPosition,
      warnings,
    });
  })
);

router.post(
  "/",
  body(schemas.createTransaction),
  asyncHandler(async (req, res) => {
    const { record, warnings } = await prepare(req.valid.body);
    const created = await txRepo.create(record);

    // Una transazione più vecchia della copertura prezzi richiede di estendere il
    // backfill, altrimenti la serie storica parte con un buco.
    if (created.instrumentId) {
      try {
        const { enqueueBackfill } = require("../../market/refresher");
        const coverage = await instrumentsRepo.priceCoverage(created.instrumentId);
        if (!coverage.from || created.tradeDate < coverage.from) {
          enqueueBackfill(created.instrumentId, { from: created.tradeDate });
        }
      } catch (err) {
        if (err?.code !== "MODULE_NOT_FOUND") throw err;
      }
    }

    return res.status(201).json({ ...created, warnings });
  })
);

router.get(
  "/:id",
  params(z.object({ id: idParam() })),
  asyncHandler(async (req, res) => {
    const tx = await txRepo.byId(req.valid.params.id);
    if (!tx) throw notFound("movimento non trovato");
    return res.json(tx);
  })
);

router.patch(
  "/:id",
  params(z.object({ id: idParam() })),
  body(schemas.updateTransaction),
  asyncHandler(async (req, res) => {
    const existing = await txRepo.byId(req.valid.params.id);
    if (!existing) throw notFound("movimento non trovato");

    // Si ricompone il record intero e si RICALCOLANO gli importi: una PATCH sul
    // solo prezzo deve aggiornare gross e net, altrimenti il ledger diventa
    // internamente incoerente.
    const merged = { ...existing, ...req.valid.body };
    const validated = parse(schemas.createTransaction, merged, "movimento aggiornato");
    const { record, warnings } = await prepare(validated);

    const updated = await txRepo.update(existing.id, record);
    return res.json({ ...updated, warnings });
  })
);

router.delete(
  "/:id",
  params(z.object({ id: idParam() })),
  asyncHandler(async (req, res) => {
    const ok = await txRepo.remove(req.valid.params.id);
    if (!ok) throw notFound("movimento non trovato");
    return res.status(204).end();
  })
);

module.exports = { router, prepare };
