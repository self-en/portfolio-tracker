import * as txRepo from "../../repo/transactions";
import * as instrumentsRepo from "../../repo/instruments";
import * as portfoliosRepo from "../../repo/portfolios";
import * as fxRepo from "../../repo/fx";
import { computeAmounts } from "../../domain/txAmounts";
import * as positions from "../../domain/positions";
import { money, qty as fmtQty, d } from "../../domain/money";
import { notFound, validation } from "../errors";
import { z, body, query, params, parse, idParam } from "../validate";
import * as schemas from "../schemas";
import { errCode } from "../../util/err";
import { enqueueBackfill } from "../../market/refresher";
import type { FastifyPluginAsync } from "fastify";
import type { DomainWarning, TxLike } from "../../domain/types";


/**
 * Prepara il record da persistere: risolve portafoglio, strumento e cambio, poi
 * calcola gli importi derivati.
 *
 * Il CALCOLO STA QUI, lato server, non in React: è la stessa funzione che alimenta
 * /preview, quindi ciò che l'utente vede nell'anteprima è esattamente ciò che verrà
 * scritto.
 */
async function prepare(input: Record<string, any>) {
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

  const amounts = computeAmounts({ ...input, tradeCcy } as TxLike, instrument);

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

const router: FastifyPluginAsync = async (app) => {
  app.get("/", { preHandler: [query(schemas.listTransactionsQuery)] }, async (req, reply) => {
    const page = await txRepo.list(req.valid.query);
    return reply.send(page);
  });

  app.post("/preview", { preHandler: [body(schemas.previewTransaction)] }, async (req, reply) => {
    const input = req.valid.body;
    const { record, instrument, amounts, warnings, fxSource } = await prepare(input);

    let resultingPosition = null;
    if (record.instrumentId) {
      // Ledger esistente + la transazione ipotetica: la posizione risultante è
      // calcolata, non stimata.
      // In modifica si esclude la transazione che si sta editando: altrimenti la si
      // sommerebbe a un ledger che già la contiene, e `resultingPosition` la
      // conterebbe due volte — un saldo credibile e sbagliato.
      const excludeId = input.excludeTransactionId ?? null;
      const existing = (
        await txRepo.ledger({
          portfolioId: record.portfolioId,
          instrumentId: record.instrumentId,
        })
      ).filter((t) => excludeId === null || t.id !== Number(excludeId));
      const instruments = new Map([[instrument!.id, instrument!]]);
      // Id sentinella: deve ordinarsi DOPO qualsiasi transazione dello stesso
      // giorno, perché è l'operazione che l'utente sta per aggiungere.
      const PENDING_ID = Number.MAX_SAFE_INTEGER;
      const before = positions.buildPositions(existing, { instruments });
      const after = positions.buildPositions([...existing, { ...record, id: PENDING_ID }], {
        instruments,
      });

      const b = before.positions.get(instrument!.id);
      const a = after.positions.get(instrument!.id);
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
        warnings.push((txId === PENDING_ID ? { ...rest, pending: true } : w) as DomainWarning);
      }
    }

    return reply.send({
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
  });

  app.post("/", { preHandler: [body(schemas.createTransaction)] }, async (req, reply) => {
    const { record, warnings } = await prepare(req.valid.body);
    const created = await txRepo.create(record);

    // Una transazione più vecchia della copertura prezzi richiede di estendere il
    // backfill, altrimenti la serie storica parte con un buco.
    if (created!.instrumentId) {
      try {
        const coverage = await instrumentsRepo.priceCoverage(created!.instrumentId);
        if (!coverage.from || created!.tradeDate < coverage.from) {
          enqueueBackfill(created!.instrumentId, { from: created!.tradeDate });
        }
      } catch (err) {
        if (errCode(err) !== "MODULE_NOT_FOUND") throw err;
      }
    }

    return reply.code(201).send({ ...created, warnings });
  });

  app.get("/:id", { preHandler: [params(z.object({ id: idParam() }))] }, async (req, reply) => {
    const tx = await txRepo.byId(req.valid.params.id);
    if (!tx) throw notFound("movimento non trovato");
    return reply.send(tx);
  });

  app.patch("/:id", { preHandler: [params(z.object({ id: idParam() })), body(schemas.updateTransaction)] }, async (req, reply) => {
    const existing = await txRepo.byId(req.valid.params.id);
    if (!existing) throw notFound("movimento non trovato");

    // Si ricompone il record intero e si RICALCOLANO gli importi: una PATCH sul
    // solo prezzo deve aggiornare gross e net, altrimenti il ledger diventa
    // internamente incoerente.
    const merged = { ...existing, ...req.valid.body };
    const validated = parse(schemas.createTransaction, merged, "movimento aggiornato");
    const { record, warnings } = await prepare(validated);

    const updated = await txRepo.update(existing.id, record);
    return reply.send({ ...updated, warnings });
  });

  app.delete("/:id", { preHandler: [params(z.object({ id: idParam() }))] }, async (req, reply) => {
    const ok = await txRepo.remove(req.valid.params.id);
    if (!ok) throw notFound("movimento non trovato");
    return reply.code(204).send();
  });
};

/**
 * Anteprima: NESSUNA SCRITTURA. Restituisce gli importi derivati e la posizione
 * risultante.
 *
 * È ciò che rende il form affidabile: l'utente vede la conseguenza prima di
 * confermare, e il calcolo del rateo vive lato server invece di essere duplicato
 * in React.
 */

export { router, prepare };
