import logger from "../../logger";
import * as eventsRepo from "../../repo/events";
import * as txRepo from "../../repo/transactions";
import * as portfoliosRepo from "../../repo/portfolios";
import * as instrumentsRepo from "../../repo/instruments";
import * as fxRepo from "../../repo/fx";
import * as positions from "../../domain/positions";
import * as cal from "../../domain/calendar";
import { d, money, toBase, ZERO, HUNDRED } from "../../domain/money";
import * as S from "../serialize";
import { notFound, conflict, validation } from "../errors";
import { z, query, body, params, idParam, dateString } from "../validate";
import * as schemas from "../schemas";
import type { FastifyPluginAsync } from "fastify";
import type Decimal from "decimal.js";
import type { Numeric } from "../../domain/money";
import type { InstrumentLike } from "../../domain/types";
import type { IncomeEventWithInstrument } from "../../repo/events";
import type { IncomeEvent } from "../../types";
import type { TransactionInput } from "../../repo/transactions";


const today = () => new Date().toISOString().slice(0, 10);

/**
 * `confidence` guida il rendering pieno vs tratteggiato in UI.
 *
 * - paid      → incassato, c'è una transazione
 * - announced → data e importo dal provider
 * - scheduled → calcolato dallo scadenzario cedolare (i BTP stanno tutti qui)
 * - estimated → importo dedotto, non dichiarato
 */
function confidenceOf(ev: IncomeEventWithInstrument): string {
  if (ev.status === "PAID") return "paid";
  if (ev.status === "ANNOUNCED") return "announced";
  if (ev.source === "schedule") return "scheduled";
  return "estimated";
}

/**
 * Importo lordo stimato di un evento, dalla quantità posseduta ALLA DATA.
 *
 * Per le cedole `amount_per_unit` è per 100 di NOMINALE, per i dividendi è per
 * azione: confondere le due convenzioni sbaglia di un fattore 10 (docs/decisions.md §9).
 */
function estimateGross(
  ev: IncomeEvent | IncomeEventWithInstrument,
  instrument: InstrumentLike | null,
  quantityAtDate: Numeric
) {
  const qty = d(quantityAtDate);
  if (qty.isZero() || ev.amountPerUnit == null) return null;

  if (ev.kind === "COUPON" || instrument?.quoteConvention === "PCT_OF_NOMINAL") {
    const nominal = qty.times(d(instrument?.faceValue, 1));
    return nominal.times(d(ev.amountPerUnit)).div(HUNDRED);
  }
  if (ev.kind === "REDEMPTION") {
    const nominal = qty.times(d(instrument?.faceValue, 1));
    return nominal.times(d(ev.amountPerUnit)).div(HUNDRED);
  }
  return qty.times(d(ev.amountPerUnit));
}

const router: FastifyPluginAsync = async (app) => {
  app.get("/", { preHandler: [query(
    z.object({
      from: dateString().optional(),
      to: dateString().optional(),
      portfolioId: z.coerce.number().int().positive().optional(),
      kind: z.string().optional(),
      status: z.string().optional(),
    })
  )] }, async (req, reply) => {
    const { portfolioId, kind, status } = req.valid.query;
    const portfolio = portfolioId
      ? await portfoliosRepo.byId(portfolioId)
      : await portfoliosRepo.first();
    if (!portfolio) throw validation("nessun portafoglio disponibile");

    // Finestra di default: 3 mesi indietro, 12 avanti. Indietro serve per
    // riconciliare ciò che è stato incassato, avanti è il vero scopo del calendario.
    const at = today();
    const from = req.valid.query.from || cal.addMonthsPreserveEom(at, -3);
    const to = req.valid.query.to || cal.addMonthsPreserveEom(at, 12);

    const events = await eventsRepo.list({
      from,
      to,
      portfolioId: portfolio.id,
      kind: kind ? kind.split(",") : undefined,
      status: status ? status.split(",") : undefined,
    });
    if (events.length === 0) {
      return reply.send({ from, to, events: [], monthlyTotals: [], warnings: [] });
    }

    // Quantità possedute ALLA DATA DI CIASCUN EVENTO: una cedola su un titolo
    // venduto il mese scorso non va stimata come se lo si avesse ancora.
    const instrumentIds = [...new Set(events.map((e) => e.instrumentId))];
    const instruments = await instrumentsRepo.mapByIds(instrumentIds);
    const ledgerByInstrument = await txRepo.ledgerByInstrument({ portfolioId: portfolio.id });

    const currencies = [...new Set(events.map((e) => e.currency))].filter(
      (c): c is string => !!c && c !== portfolio.baseCcy
    );
    const fxRates = await fxRepo.ratesAsOf(currencies, to, portfolio.baseCcy);

    // Serie di quantità per strumento sulle sole date che servono.
    const qtyByInstrument = new Map<number, Map<string, Decimal>>();
    for (const id of instrumentIds) {
      const txs = ledgerByInstrument.get(id) || [];
        const dates = [...new Set(events.filter((e) => e.instrumentId === id).map((e) => e.payDate))]
        .filter((d): d is string => !!d)
        .sort();
      // Quantità "come transata", non aggiustata per gli split: una cedola si
      // incassa sulle quantità realmente possedute a quella data.
      const series = positions.splitAdjustedQuantitySeries(txs, dates);
      qtyByInstrument.set(id, new Map(series.map((s, i) => [dates[i] as string, s.raw])));
    }

    const warnings: Array<Record<string, unknown>> = [];
    const out: Array<Record<string, unknown>> = [];
    const monthly = new Map<string, Record<string, any>>();

    for (const ev of events) {
      const inst = instruments.get(ev.instrumentId) || null;
      const qtyAtDate = qtyByInstrument.get(ev.instrumentId)?.get(ev.payDate ?? "") ?? ZERO;
      const gross = estimateGross(ev, inst, qtyAtDate);

      const fxRate = ev.currency === portfolio.baseCcy ? "1" : fxRates.get(ev.currency);
      if (ev.currency !== portfolio.baseCcy && !fxRate) {
        warnings.push({
          code: "fx_missing",
          currency: ev.currency,
          message: `nessun cambio ${portfolio.baseCcy}/${ev.currency}: importo non convertito`,
        });
      }
      const grossBase = gross === null ? null : toBase(gross, fxRate ?? "1");

      out.push({
        id: ev.id,
        kind: ev.kind,
        status: ev.status,
        instrument: {
          id: inst?.id ?? ev.instrumentId,
          name: inst?.name ?? null,
          ticker: inst?.ticker ?? null,
          isin: inst?.isin ?? null,
          assetClass: inst?.assetClass ?? null,
        },
        exDate: ev.exDate,
        payDate: ev.payDate,
        amountPerUnit: ev.amountPerUnit,
        // La convenzione dell'importo va DICHIARATA: per le cedole è per 100 di
        // nominale, per i dividendi per azione.
        amountUnit:
          ev.kind === "COUPON" || ev.kind === "REDEMPTION" ? "per_100_nominale" : "per_azione",
        currency: ev.currency,
        splitRatio: ev.splitRatio,
        quantityAtDate: S.q(qtyAtDate),
        estimatedGross: S.m(gross),
        estimatedGrossBase: S.m(grossBase),
        confidence: confidenceOf(ev),
        transactionId: ev.transactionId,
        source: ev.source,
      });

      // I totali mensili escludono i rimborsi: un rimborso a scadenza è capitale che
      // rientra, non reddito, e sommarlo gonfierebbe il grafico di un ordine di
      // grandezza.
      if (grossBase !== null && ev.kind !== "REDEMPTION" && ev.kind !== "SPLIT") {
        const key = cal.monthKey(ev.payDate as string);
        let bucket = monthly.get(key);
        if (!bucket) {
          bucket = { gross: ZERO, confirmed: ZERO, projected: ZERO };
          monthly.set(key, bucket);
        }
        bucket.gross = bucket.gross.plus(grossBase);
        if (ev.status === "PAID") bucket.confirmed = bucket.confirmed.plus(grossBase);
        else bucket.projected = bucket.projected.plus(grossBase);
      }
    }

    return reply.send({
      from,
      to,
      baseCcy: portfolio.baseCcy,
      events: out,
      monthlyTotals: [...monthly.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([month, v]) => ({
          month,
          gross: S.m(v.gross),
          // Confermato e proiettato separati: la UI li distingue col canale TEXTURE
          // (tratteggio), non con una seconda tinta.
          confirmed: S.m(v.confirmed),
          projected: S.m(v.projected),
        })),
      warnings,
    });
  });

  app.post("/:id/confirm", { preHandler: [params(z.object({ id: idParam() })), body(schemas.confirmEventBody)] }, async (req, reply) => {
    const ev = await eventsRepo.byId(req.valid.params.id);
    if (!ev) throw notFound("evento non trovato");
    if (ev.transactionId) {
      throw conflict("evento già confermato", { transactionId: ev.transactionId });
    }
    if (ev.kind === "SPLIT") {
      throw validation(
        "uno split va registrato come movimento di tipo SPLIT, non come reddito",
        { hint: "POST /api/transactions con type: 'SPLIT' e splitRatio" }
      );
    }

    const input = req.valid.body;
    const portfolio = input.portfolioId
      ? await portfoliosRepo.byId(input.portfolioId)
      : await portfoliosRepo.first();
    if (!portfolio) throw validation("nessun portafoglio disponibile");

    const inst = await instrumentsRepo.byId(ev.instrumentId);
    if (!inst) throw notFound("strumento dell'evento non trovato");

    const tradeDate = input.tradeDate || ev.payDate;

    // Lordo: quello indicato dall'utente, altrimenti stimato dallo scadenzario
    // sulla quantità posseduta a quella data.
    let gross = input.grossAmount;
    if (gross == null) {
      const txs = (await txRepo.ledgerByInstrument({ portfolioId: portfolio.id })).get(
        ev.instrumentId
      ) || [];
      const series = positions.splitAdjustedQuantitySeries(txs, [tradeDate]);
      const estimated = estimateGross(ev, inst, series[0].raw);
      if (estimated === null || estimated.isZero()) {
        throw validation(
          "impossibile stimare l'importo: nessuna quantità posseduta a quella data",
          { hint: "indica grossAmount esplicitamente" }
        );
      }
      gross = money(estimated);
    }

    const type = ev.kind === "COUPON" ? "COUPON" : ev.kind === "REDEMPTION" ? "SELL" : "DIVIDEND";

    // Un rimborso a scadenza è una VENDITA al 100% del nominale, non un reddito:
    // chiude la posizione e realizza la differenza rispetto al carico.
    if (type === "SELL") {
      throw validation(
        "il rimborso a scadenza va registrato come vendita al 100 del nominale",
        {
          hint: "POST /api/transactions con type: 'SELL', price: '100' e la quantità in scadenza",
          payDate: ev.payDate,
        }
      );
    }

    let fxRate = input.fxRate ?? null;
    if (!fxRate && ev.currency !== "EUR") {
      const cached = await fxRepo.rateAsOf(ev.currency, tradeDate);
      fxRate = cached?.rate ?? null;
    }
    if (ev.currency === "EUR") fxRate = "1";

    const grossD = d(gross);
    const netAmount = grossD.minus(d(input.taxes)).minus(d(input.fees));
    if (netAmount.lt(0)) {
      throw validation("ritenuta e commissioni superano il lordo");
    }

    const created = await txRepo.create({
      portfolioId: portfolio.id,
      instrumentId: ev.instrumentId,
      type,
      tradeDate,
      grossAmount: money(grossD),
      taxes: input.taxes,
      fees: input.fees,
      accruedInterest: "0",
      netAmount: money(netAmount),
      tradeCcy: ev.currency,
      fxRate,
      note: input.note ?? `Confermato dal calendario (evento #${ev.id})`,
    } as TransactionInput);

    const updated = await eventsRepo.markPaid(ev.id, created!.id);
    logger.info(
      { eventId: ev.id, transactionId: created!.id, type },
      "[calendar] evento confermato e movimento creato"
    );

    return reply.code(201).send({ event: updated, transaction: created });
  });

  app.delete("/:id", { preHandler: [params(z.object({ id: idParam() }))] }, async (req, reply) => {
    const ev = await eventsRepo.byId(req.valid.params.id);
    if (!ev) throw notFound("evento non trovato");
    if (ev.transactionId) {
      throw conflict("l'evento è collegato a un movimento: elimina prima il movimento", {
        transactionId: ev.transactionId,
      });
    }
    await eventsRepo.remove(ev.id);
    return reply.code(204).send();
  });
};

/**
 * CONFERMA UN EVENTO → crea la transazione corrispondente.
 *
 * In un'app a inserimento manuale questo trasforma il calendario nel canale
 * PRIMARIO di data entry: l'utente vede "cedola BTP il 1° luglio, ~172,50" e con un
 * click ha il movimento registrato, con il lordo precompilato dallo scadenzario e
 * solo la ritenuta da inserire.
 */

export { router, confidenceOf, estimateGross };
