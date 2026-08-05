// La superficie CALCOLATA. Queste route orchestrano: repo → domain → risposta.
// Nessuna logica di business qui dentro, nessun SQL.
import express from "express";
import { z, dateString } from "../validate";
import * as portfoliosRepo from "../../repo/portfolios";
import * as txRepo from "../../repo/transactions";
import * as instrumentsRepo from "../../repo/instruments";
import * as pricesRepo from "../../repo/prices";
import * as fxRepo from "../../repo/fx";
import * as positions from "../../domain/positions";
import * as valuation from "../../domain/valuation";
import * as returns from "../../domain/returns";
import * as cal from "../../domain/calendar";
import { d, ZERO } from "../../domain/money";
import * as S from "../serialize";
import { asyncHandler, validation } from "../errors";
import { query } from "../validate";
import * as schemas from "../schemas";
import type { Request, Response } from "express";

const router = express.Router();

/** Oggi in UTC. Il tempo entra nel sistema QUI: domain/ lo riceve come parametro. */
const today = () => new Date().toISOString().slice(0, 10);

/**
 * Carica tutto ciò che serve per valorizzare un portafoglio a una data.
 *
 * Una sola funzione condivisa da summary/positions/allocation/returns, così le
 * quattro risposte non possono divergere.
 */
async function loadValuation({ portfolioId, asOf, includeAccrued }) {
  const portfolio = portfolioId
    ? await portfoliosRepo.byId(portfolioId)
    : await portfoliosRepo.first();
  if (!portfolio) throw validation("nessun portafoglio disponibile");

  const at = asOf || today();
  const ledger = await txRepo.ledger({ portfolioId: portfolio.id, asOf: at });

  const instrumentIds = [...new Set(ledger.map((t) => t.instrumentId).filter((x) => x != null))];
  const instruments = await instrumentsRepo.mapByIds(instrumentIds);

  // Valute in gioco, per caricare i cambi in una sola query.
  const currencies = [
    ...new Set([
      ...[...instruments.values()].map((i) => i.currency),
      ...ledger.map((t) => t.tradeCcy),
    ]),
  ].filter((c) => c && c !== portfolio.baseCcy);

  const fxRates = await fxRepo.ratesAsOf(currencies, at, portfolio.baseCcy);
  const fxSeries = await fxRepo.seriesForMany(currencies, { to: at, base: portfolio.baseCcy });

  // Lookup FX puro da passare a domain/: forward-fill sulle serie sparse.
  const fxLookups = new Map();
  for (const [ccy, rows] of fxSeries) {
    fxLookups.set(ccy, cal.forwardFillLookup(rows, { valueKey: "rate" }));
  }
  const fxLookup = (ccy, date) => {
    if (!ccy || ccy === portfolio.baseCcy) return "1";
    const lk = fxLookups.get(ccy);
    const hit = lk ? lk(date) : null;
    // Ripiego sul tasso più recente: meglio un cambio leggermente vecchio che un
    // warning su ogni transazione storica quando la copertura FX parte dopo.
    return hit?.value ?? fxRates.get(ccy) ?? null;
  };

  const built = positions.buildPositions(ledger, {
    baseCcy: portfolio.baseCcy,
    instruments,
    fxLookup,
  });

  // Quotazioni: prima quotes_latest (intraday), poi l'ultima chiusura nota.
  // Per una data storica si usa SEMPRE la chiusura: la quotazione corrente
  // risponderebbe alla domanda sbagliata.
  const isToday = at >= today();
  const liveQuotes = isToday ? await pricesRepo.latestQuotes(instrumentIds) : new Map();
  const closes = await pricesRepo.latestAsOf(instrumentIds, at);

  const quotes = new Map();
  for (const id of instrumentIds) {
    const live = liveQuotes.get(id);
    const close = closes.get(id);
    if (live && isToday) {
      quotes.set(id, {
        price: live.price,
        previousClose: live.previousClose ?? close?.price ?? null,
        currency: live.currency,
        asOf: live.fetchedAt,
        priceDate: close?.priceDate ?? null,
        source: live.source,
        // `stale` alimenta il badge "prezzi aggiornati alle ...": la UI deve poter
        // distinguere un dato fresco da uno di ieri.
        stale: Date.now() - new Date(live.fetchedAt).getTime() > 24 * 3600 * 1000,
      });
    } else if (close) {
      quotes.set(id, {
        price: close.price,
        previousClose: null,
        asOf: close.priceDate,
        priceDate: close.priceDate,
        source: close.source,
        stale: close.priceDate < cal.addDays(at, -4),
      });
    }
  }

  const valued = valuation.valuePositions({
    asOf: at,
    built,
    instruments,
    quotes,
    fxRates,
    baseCcy: portfolio.baseCcy,
    includeAccrued: !!includeAccrued,
  });

  return { portfolio, asOf: at, ledger, instruments, built, valued, fxLookup, currencies };
}

router.get(
  "/summary",
  query(schemas.portfolioQuery),
  asyncHandler(async (req: Request, res: Response) => {
    const { portfolioId, asOf, includeAccrued } = req.valid.query;
    const ctx = await loadValuation({ portfolioId, asOf, includeAccrued });
    const { valued, portfolio } = ctx;

    // TWR e XIRR hanno bisogno della serie storica: si costruisce sul range ALL,
    // perché sono metriche "dall'inizio".
    const earliest = await txRepo.earliestDate(portfolio.id);
    let twr = { total: null, annualized: null };
    let xirr = null;

    if (earliest) {
      const { dates } = cal.buildGrid(earliest, ctx.asOf, "auto");
      const txsByInstrument = await txRepo.ledgerByInstrument({
        portfolioId: portfolio.id,
        asOf: ctx.asOf,
      });
      const pricesByInstrument = await pricesRepo.seriesForMany([...ctx.instruments.keys()], {
        to: ctx.asOf,
      });
      const fxByCcy = await fxRepo.seriesForMany(ctx.currencies, {
        to: ctx.asOf,
        base: portfolio.baseCcy,
      });

      const series = valuation.valueSeries({
        dates,
        txsByInstrument,
        instruments: ctx.instruments,
        pricesByInstrument,
        fxByCcy,
        flows: ctx.built.flows,
        baseCcy: portfolio.baseCcy,
        includeAccrued: !!includeAccrued,
      });

      twr = returns.twr(series.points, returns.inflowsByDate(ctx.built.flows));
      const x = returns.portfolioXirr(ctx.built.flows, valued.totals.totalValue, ctx.asOf);
      xirr = x ? x.rate : null;
    }

    const byAssetClass = valuation.allocate(
      valued.rows,
      (r) => r.instrument.assetClass || "—",
      (r) => r.instrument.assetClass || "Non classificato"
    );
    const byCurrency = valuation.allocate(valued.rows, (r) => r.currency, (r) => r.currency);

    return res.json({
      asOf: ctx.asOf,
      portfolioId: portfolio.id,
      baseCcy: portfolio.baseCcy,
      ...S.summaryTotals(valued.totals),
      twr: { total: twr.total, annualized: twr.annualized },
      // La dashboard mostra lo XIRR come percentuale principale: risponde alla
      // domanda "quanto hanno reso i miei soldi", che è ciò che chiede davvero un
      // investitore con versamenti irregolari.
      xirr,
      byAssetClass: byAssetClass.map((g) => ({
        assetClass: g.key,
        marketValue: S.m(g.marketValue),
        weight: S.pct(g.weight),
      })),
      byCurrency: byCurrency.map((g) => ({
        currency: g.key,
        marketValue: S.m(g.marketValue),
        weight: S.pct(g.weight),
      })),
      cash: Object.fromEntries(Object.entries(ctx.built.cash).map(([k, v]) => [k, S.m(v)])),
      positionsCount: valued.rows.filter((r) => !d(r.quantity).isZero()).length,
      stale: valued.rows.some((r) => r.stale),
      // Nota non fiscale, esposta dall'API così ogni client la mostra.
      disclaimer:
        "Non è consulenza fiscale: plusvalenze realizzate, redditi e plusvalenze latenti sono voci separate. Riconcilia con l'estratto conto del broker.",
      warnings: valued.warnings,
    });
  })
);

router.get(
  "/positions",
  query(schemas.portfolioQuery),
  asyncHandler(async (req: Request, res: Response) => {
    const { portfolioId, asOf, includeAccrued } = req.valid.query;
    const ctx = await loadValuation({ portfolioId, asOf, includeAccrued });
    // Le posizioni chiuse restano visibili (portano il realizzato) ma vanno in
    // fondo: in cima ci va ciò che si possiede.
    const rows = [...ctx.valued.rows].sort((a, b) => {
      const aOpen = !d(a.quantity).isZero();
      const bOpen = !d(b.quantity).isZero();
      if (aOpen !== bOpen) return aOpen ? -1 : 1;
      const av = a.marketValueBase ?? d(0);
      const bv = b.marketValueBase ?? d(0);
      return bv.comparedTo(av);
    });
    return res.json({
      asOf: ctx.asOf,
      baseCcy: ctx.portfolio.baseCcy,
      items: rows.map(S.position),
      warnings: ctx.valued.warnings,
    });
  })
);

router.get(
  "/value-series",
  query(schemas.seriesQuery),
  asyncHandler(async (req: Request, res: Response) => {
    const { portfolioId, asOf, range, granularity, includeAccrued } = req.valid.query;
    const portfolio = portfolioId
      ? await portfoliosRepo.byId(portfolioId)
      : await portfoliosRepo.first();
    if (!portfolio) throw validation("nessun portafoglio disponibile");

    const at = asOf || today();
    const earliest = await txRepo.earliestDate(portfolio.id);
    if (!earliest) {
      return res.json({ points: [], meta: { granularity: "day", range, warnings: [] } });
    }

    const { from, to } = cal.resolveRange(range, at, earliest);
    const grid = cal.buildGrid(from, to, granularity);

    // Il ledger COMPLETO (non solo dal `from`): le quantità e il carico a `from`
    // dipendono da tutto ciò che è avvenuto prima.
    const txsByInstrument = await txRepo.ledgerByInstrument({ portfolioId: portfolio.id, asOf: to });
    const ids = [...txsByInstrument.keys()];
    const instruments = await instrumentsRepo.mapByIds(ids);
    const currencies = [...new Set([...instruments.values()].map((i) => i.currency))].filter(
      (c) => c && c !== portfolio.baseCcy
    );

    const pricesByInstrument = await pricesRepo.seriesForMany(ids, { to });
    const fxByCcy = await fxRepo.seriesForMany(currencies, { to, base: portfolio.baseCcy });

    const ledger = await txRepo.ledger({ portfolioId: portfolio.id, asOf: to });
    const built = positions.buildPositions(ledger, {
      baseCcy: portfolio.baseCcy,
      instruments,
    });

    const series = valuation.valueSeries({
      dates: grid.dates,
      txsByInstrument,
      instruments,
      pricesByInstrument,
      fxByCcy,
      flows: built.flows,
      baseCcy: portfolio.baseCcy,
      includeAccrued: !!includeAccrued,
    });

    return res.json({
      points: series.points.map(S.seriesPoint),
      meta: {
        range,
        granularity: grid.granularity,
        from,
        to,
        baseCcy: portfolio.baseCcy,
        // Quanti punti hanno dati incompleti: la UI può dirlo in una riga sopra il
        // grafico invece di lasciar credere a un crollo.
        partialPoints: series.points.filter((p) => p.partial).length,
        warnings: series.warnings,
      },
    });
  })
);

router.get(
  "/allocation",
  query(
    schemas.portfolioQuery.extend({
      by: z
        .enum(["assetClass", "currency", "instrument", "issuer"])
        .default("assetClass"),
    })
  ),
  asyncHandler(async (req: Request, res: Response) => {
    const { portfolioId, asOf, by } = req.valid.query;
    const ctx = await loadValuation({ portfolioId, asOf });

    const keyFns = {
      assetClass: [(r) => r.instrument.assetClass || "—", (r) => r.instrument.assetClass || "Non classificato"],
      currency: [(r) => r.currency, (r) => r.currency],
      instrument: [(r) => r.instrument.id, (r) => r.instrument.name],
      issuer: [(r) => r.instrument.issuer || "—", (r) => r.instrument.issuer || "Non indicato"],
    };
    const [keyFn, labelFn] = keyFns[by];
    let groups = valuation.allocate(ctx.valued.rows, keyFn, labelFn);

    // L'allocazione per strumento sfonderebbe i cap della palette (≤3 tinte per le
    // forme all-pairs, ≤8 adiacenti): si ripiega la coda in "Altro" così la UI non
    // sia costretta a generare una nona tinta.
    const MAX_SLICES = 8;
    if (groups.length > MAX_SLICES) {
      const head = groups.slice(0, MAX_SLICES - 1);
      const tail = groups.slice(MAX_SLICES - 1);
      // ZERO importato in testa al file
      head.push({
        key: "__altro__",
        label: `Altro (${tail.length})`,
        marketValue: tail.reduce((acc, g) => acc.plus(g.marketValue), ZERO),
        weight: tail.reduce((acc, g) => acc.plus(g.weight), ZERO),
      });
      groups = head;
    }

    return res.json({
      asOf: ctx.asOf,
      by,
      baseCcy: ctx.portfolio.baseCcy,
      items: groups.map(S.allocationGroup),
    });
  })
);

router.get(
  "/returns",
  query(schemas.seriesQuery),
  asyncHandler(async (req: Request, res: Response) => {
    const { portfolioId, asOf, range, granularity } = req.valid.query;
    const ctx = await loadValuation({ portfolioId, asOf });
    const { portfolio } = ctx;

    const earliest = await txRepo.earliestDate(portfolio.id);
    if (!earliest) {
      return res.json({ twr: null, xirr: null, simple: null, byYear: [], flows: [] });
    }

    const { from, to } = cal.resolveRange(range, ctx.asOf, earliest);
    const grid = cal.buildGrid(from, to, granularity);
    const txsByInstrument = await txRepo.ledgerByInstrument({ portfolioId: portfolio.id, asOf: to });
    const pricesByInstrument = await pricesRepo.seriesForMany([...ctx.instruments.keys()], { to });
    const fxByCcy = await fxRepo.seriesForMany(ctx.currencies, { to, base: portfolio.baseCcy });

    const series = valuation.valueSeries({
      dates: grid.dates,
      txsByInstrument,
      instruments: ctx.instruments,
      pricesByInstrument,
      fxByCcy,
      flows: ctx.built.flows,
      baseCcy: portfolio.baseCcy,
    });

    const inflows = returns.inflowsByDate(ctx.built.flows);
    const twr = returns.twr(series.points, inflows);
    const x = returns.portfolioXirr(ctx.built.flows, ctx.valued.totals.totalValue, ctx.asOf);

    // Il rendimento semplice è mostrato solo come riferimento: a livello di
    // portafoglio con versamenti irregolari è fuorviante, e non va usato come
    // cifra principale.
    const netInvested = returns.netInvestedSeries(ctx.built.flows, [ctx.asOf])[0].netInvested;
    const simple = returns.simpleReturn(ctx.valued.totals.totalValue, netInvested);

    return res.json({
      asOf: ctx.asOf,
      baseCcy: portfolio.baseCcy,
      twr: { total: twr.total, annualized: twr.annualized, days: twr.days, segments: twr.segments },
      xirr: x ? x.rate : null,
      xirrMethod: x ? x.method : null,
      simple,
      netInvested: S.m(netInvested),
      marketValue: S.m(ctx.valued.totals.totalValue),
      byYear: returns.byYear(series.points, ctx.built.flows),
      flows: ctx.built.flows.map((f) => ({ date: f.date, amount: S.m(f.amountBase), type: f.type })),
      notes: {
        xirr: "Rendimento monetario (MWR): pesa i versamenti per quanto tempo sono stati investiti.",
        twr: "Rendimento indipendente dal timing dei versamenti: il numero da confrontare con un indice.",
      },
      warnings: series.warnings,
    });
  })
);

router.get(
  "/income",
  query(
    schemas.portfolioQuery.extend({
      from: dateString().optional(),
      to: dateString().optional(),
      groupBy: z.enum(["month", "instrument"]).default("month"),
    })
  ),
  asyncHandler(async (req: Request, res: Response) => {
    const { portfolioId, from, to, groupBy } = req.valid.query;
    const portfolio = portfolioId
      ? await portfoliosRepo.byId(portfolioId)
      : await portfoliosRepo.first();
    if (!portfolio) throw validation("nessun portafoglio disponibile");

    const rows = await txRepo.incomeByPeriod({ portfolioId: portfolio.id, from, to, groupBy });
    const totals = rows.reduce(
      (acc, r) => ({
        gross: acc.gross.plus(d(r.gross)),
        taxes: acc.taxes.plus(d(r.taxes)),
        net: acc.net.plus(d(r.net)),
      }),
      { gross: ZERO, taxes: ZERO, net: ZERO }
    );

    return res.json({
      groupBy,
      baseCcy: portfolio.baseCcy,
      items: rows.map((r) => ({
        key: r.key,
        // Lordo, ritenuta e netto sempre e solo come tre voci separate.
        gross: S.m(r.gross),
        taxes: S.m(r.taxes),
        net: S.m(r.net),
        count: r.count,
        currency: r.currency,
      })),
      totals: { gross: S.m(totals.gross), taxes: S.m(totals.taxes), net: S.m(totals.net) },
    });
  })
);

export { router, loadValuation, today };
