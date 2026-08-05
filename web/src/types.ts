// I payload dell'API, come li vede la SPA.
//
// Sono lo specchio di `src/http/serialize.ts` e delle route in
// `src/http/routes/` sul server (che sono l'unico posto che decide la forma delle
// risposte): se cambia lì, va cambiato qui. Non c'è generazione automatica di
// proposito - il server e la SPA sono due pacchetti separati, e un tipo scritto a
// mano che qualcuno deve aggiornare è più onesto di uno generato che nessuno
// guarda.
//
// **Ogni importo è una STRINGA**, mai un number: il denaro viaggia come stringa
// decimale da un capo all'altro (docs/decisions.md §1). Se vedi uno di questi
// campi dentro un'espressione aritmetica, è un bug.
//
// Le risposte sono modellate come ENVELOPE (`PositionsResponse`, `SummaryResponse`,
// ...) e non come il solo array di righe: quasi tutte portano `asOf`/`baseCcy`/
// `warnings` accanto ai dati, e la valuta base serve a ogni formattazione.

/** Importo/quantità/prezzo: stringa decimale, oppure null se non calcolabile. */
export type Amount = string | null;
/** Data "YYYY-MM-DD". */
export type DateString = string;

/** Un avvertimento che accompagna un risultato invece di interromperlo. */
export interface Warning {
  code: string;
  message?: string;
  instrumentId?: number | null;
  instrumentName?: string | null;
  currency?: string | null;
  date?: DateString | null;
  /** true quando il warning riguarda l'operazione in corso (anteprima movimento). */
  pending?: boolean;
  txId?: number;
  details?: unknown;
}

// ---------------------------------------------------------------------------
// Strumenti
// ---------------------------------------------------------------------------

/**
 * Lo strumento come compare INCASSATO in un'altra risposta (posizioni, movimenti,
 * eventi di calendario): un sottoinsieme, non lo strumento completo. Quali campi
 * siano presenti dipende da chi lo serializza, quindi gli extra sono opzionali.
 */
export interface InstrumentRef {
  id: number;
  name: string | null;
  ticker: string | null;
  isin: string | null;
  assetClass: string | null;
  currency?: string;
  quoteConvention?: string | null;
  faceValue?: Amount;
  issuer?: string | null;
  priceSource?: string | null;
}

/** La quotazione corrente, quando c'è (`latestQuote` sugli strumenti). */
export interface LatestQuote {
  price: Amount;
  currency: string | null;
  previousClose: Amount;
  /** Istante ISO del fetch (`fetchedAt` sul server). */
  asOf: string | null;
  marketState: string | null;
  source: string | null;
}

/** I campi obbligazionari, raggruppati da `withBondDetails` sul server. */
export interface BondDetails {
  faceValue: Amount;
  couponRate: Amount;
  couponFrequency: number | null;
  firstCouponDate: DateString | null;
  maturityDate: DateString | null;
  dayCount: string | null;
}

/** Quanta storia prezzi c'è per uno strumento. */
export interface PriceCoverage {
  from: DateString | null;
  to: DateString | null;
  rows: number;
}

/** Una cedola dello scadenzario calcolato (`domain/bonds.ts#couponSchedule`). */
export interface CouponScheduleEntry {
  periodStart: DateString;
  periodEnd: DateString;
  payDate: DateString;
  /** Confini QUASI-cedolari: il denominatore del rateo ACT/ACT-ICMA. */
  quasiStart: DateString;
  quasiEnd: DateString;
  amountPer100: string;
  /** true per il primo periodo stub, il cui importo è ridotto. */
  irregular: boolean;
}

/**
 * Uno strumento come lo restituisce l'API (`withBondDetails`): i campi
 * obbligazionari NON sono in cima ma dentro `bond`, presente solo per i titoli
 * che ne hanno.
 */
export interface Instrument {
  id: number;
  assetClass: string | null;
  name: string;
  ticker: string | null;
  isin: string | null;
  exchange: string | null;
  currency: string;
  priceSource: string | null;
  quoteConvention: string | null;
  issuer: string | null;
  notes: string | null;
  active: boolean;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  /** Presente solo per le obbligazioni (vedi withBondDetails sul server). */
  bond?: BondDetails;
  latestQuote?: LatestQuote | null;
  /** Solo su GET /api/instruments/:id. */
  priceCoverage?: PriceCoverage;
  couponSchedule?: CouponScheduleEntry[];
  currentYield?: Amount;
  warnings?: Warning[];
}

export interface InstrumentsResponse {
  items: Instrument[];
}

/** Una riga di GET /api/instruments/:id/prices. */
export interface PricePoint {
  date: DateString;
  close: Amount;
  source: string | null;
}

export interface PricesResponse {
  items: PricePoint[];
  currency: string;
  quoteConvention: string | null;
}

/** Un risultato di GET /api/market/search (Yahoo non restituisce la valuta). */
export interface SymbolHit {
  symbol: string;
  name: string;
  exchange: string | null;
  quoteType: string | null;
  currency: string | null;
  score: string | null;
}

export interface SymbolSearchResponse {
  items: SymbolHit[];
  cached: boolean;
}

// ---------------------------------------------------------------------------
// Portafogli e movimenti
// ---------------------------------------------------------------------------

export interface Portfolio {
  id: number;
  name: string;
  baseCcy: string;
  broker: string | null;
  createdAt?: string;
}

export interface PortfoliosResponse {
  items: Portfolio[];
}

export interface Transaction {
  id: number;
  portfolioId: number;
  instrumentId: number | null;
  type: string;
  tradeDate: DateString;
  settleDate: DateString | null;
  quantity: Amount;
  price: Amount;
  grossAmount: Amount;
  fees: Amount;
  taxes: Amount;
  accruedInterest: Amount;
  netAmount: Amount;
  tradeCcy: string;
  fxRate: Amount;
  splitRatio: Amount;
  note: string | null;
  externalRef?: string | null;
  createdAt?: string;
  updatedAt?: string;
  instrument?: InstrumentRef | null;
  /** Presente sulle risposte di POST/PATCH, non sull'elenco. */
  warnings?: Warning[];
}

/** GET /api/transactions: paginazione a cursore, non a offset. */
export interface TransactionsPage {
  items: Transaction[];
  nextCursor: string | null;
}

/** La posizione risultante da un movimento ipotetico (anteprima). */
export interface ResultingPosition {
  quantityBefore: string;
  quantityAfter: string;
  costBasisBefore: string;
  costBasisAfter: string;
  avgCostAfter: Amount;
  realizedPnlDelta: string;
}

/** POST /api/transactions/preview: nessuna scrittura, solo gli importi derivati. */
export interface TransactionPreview {
  grossAmount: Amount;
  netAmount: Amount;
  accruedInterest: Amount;
  /** true quando il rateo è stato calcolato dallo scadenzario, non digitato. */
  accruedAuto: boolean;
  quantity: Amount;
  nominal: Amount;
  fxRate: Amount;
  /** "input" | "base" | "cache:YYYY-MM-DD" | null. */
  fxSource: string | null;
  tradeCcy: string;
  resultingPosition: ResultingPosition | null;
  warnings: Warning[];
}

// ---------------------------------------------------------------------------
// Posizioni, totali, serie
// ---------------------------------------------------------------------------

/** Una riga di GET /api/portfolio/positions (`serialize.ts#position`). */
export interface PositionRow {
  instrument: InstrumentRef;
  quantity: Amount;
  /** Il nominale, solo per i titoli quotati in percentuale sul nominale. */
  nominal: Amount;
  avgCost: Amount;
  costBasis: Amount;
  price: Amount;
  priceDate: DateString | null;
  priceSource: string | null;
  marketValue: Amount;
  marketValueBase: Amount;
  weight: Amount;
  unrealizedPnl: Amount;
  unrealizedPnlPct: Amount;
  // Realizzato, redditi e latente restano TRE VOCI SEPARATE: non vengono mai
  // sommate in un unico "profitto" (docs/decisions.md §3).
  realizedPnl: Amount;
  incomeGross: Amount;
  taxWithheld: Amount;
  incomeNet: Amount;
  accruedInterest: Amount;
  feesTotal: Amount;
  dayChange: Amount;
  fxRate: Amount;
  priced: boolean;
  stale: boolean;
  warnings: Warning[];
}

export interface PositionsResponse {
  asOf: DateString;
  baseCcy: string;
  items: PositionRow[];
  warnings: Warning[];
}

/** I totali calcolati da `serialize.ts#summaryTotals`, condivisi da più risposte. */
export interface SummaryTotals {
  marketValue: Amount;
  totalValue: Amount;
  costBasis: Amount;
  unrealizedPnl: Amount;
  unrealizedPnlPct: Amount;
  realizedPnl: Amount;
  incomeGross: Amount;
  taxWithheld: Amount;
  incomeNet: Amount;
  accruedInterest: Amount;
  feesTotal: Amount;
  dayChange: Amount;
  dayChangePct: Amount;
}

/** Il rendimento nel tempo, indipendente dal timing dei versamenti. */
export interface Twr {
  total: Amount;
  annualized: Amount;
  days?: number;
  segments?: number;
}

/** GET /api/portfolio/summary: i totali PIÙ le allocazioni e il rendimento. */
export interface Summary extends SummaryTotals {
  asOf: DateString;
  portfolioId: number;
  baseCcy: string;
  twr: Twr;
  /** Rendimento monetario (MWR): la percentuale principale della dashboard. */
  xirr: Amount;
  byAssetClass: Array<{ assetClass: string; marketValue: Amount; weight: Amount }>;
  byCurrency: Array<{ currency: string; marketValue: Amount; weight: Amount }>;
  cash: Record<string, Amount>;
  positionsCount: number;
  stale: boolean;
  disclaimer: string;
  warnings: Warning[];
}

/** Un punto di /api/portfolio/value-series. */
export interface SeriesPoint {
  date: DateString;
  value: Amount;
  cost: Amount;
  netInvested: Amount;
  pnl: Amount;
  accrued: Amount;
  /** true quando il punto è calcolato con dati incompleti (prezzo o cambio assenti). */
  partial: boolean;
}

export interface ValueSeriesResponse {
  points: SeriesPoint[];
  meta: {
    range: string;
    granularity: string;
    from?: DateString;
    to?: DateString;
    baseCcy?: string;
    /** Quanti punti hanno dati incompleti: da dire in una riga sopra il grafico. */
    partialPoints?: number;
    warnings: Warning[];
  };
}

/** Un gruppo di /api/portfolio/allocation (`serialize.ts#allocationGroup`). */
export interface AllocationGroup {
  key: string;
  label: string;
  marketValue: Amount;
  weight: Amount;
}

export interface AllocationResponse {
  asOf: DateString;
  by: string;
  baseCcy: string;
  items: AllocationGroup[];
}

/**
 * GET /api/portfolio/returns.
 *
 * Senza movimenti il server risponde con tutto a null: da qui i campi opzionali,
 * che non sono pigrizia ma la forma reale della risposta vuota.
 */
export interface Returns {
  asOf?: DateString;
  baseCcy?: string;
  twr: Twr | null;
  xirr: Amount;
  xirrMethod?: string | null;
  /** Solo come riferimento: a livello di portafoglio è fuorviante come cifra principale. */
  simple: Amount;
  netInvested?: Amount;
  marketValue?: Amount;
  byYear: Array<{ year: string; twr: Amount; xirr: Amount }>;
  flows: Array<{ date: DateString; amount: Amount; type?: string }>;
  notes?: { xirr: string; twr: string };
  warnings?: Warning[];
}

/** GET /api/portfolio/income. */
export interface IncomeResponse {
  groupBy: string;
  baseCcy: string;
  items: Array<{
    key: string;
    // Lordo, ritenuta e netto sempre e solo come tre voci separate.
    gross: Amount;
    taxes: Amount;
    net: Amount;
    count: number;
    currency: string | null;
  }>;
  totals: { gross: Amount; taxes: Amount; net: Amount };
}

// ---------------------------------------------------------------------------
// Calendario
// ---------------------------------------------------------------------------

/**
 * Una voce di /api/calendar.
 *
 * `confidence` guida il rendering pieno vs tratteggiato: "paid" (incassato),
 * "announced" (dal provider), "scheduled" (dallo scadenzario - i BTP stanno tutti
 * qui) oppure "estimated" (importo dedotto).
 */
export interface CalendarEvent {
  id: number;
  kind: string;
  status: string;
  instrument: InstrumentRef;
  exDate: DateString | null;
  payDate: DateString | null;
  amountPerUnit: Amount;
  /** La convenzione dell'importo, DICHIARATA: per 100 di nominale o per azione. */
  amountUnit: "per_100_nominale" | "per_azione";
  currency: string;
  splitRatio: Amount;
  quantityAtDate: Amount;
  estimatedGross: Amount;
  estimatedGrossBase: Amount;
  confidence: "paid" | "announced" | "scheduled" | "estimated";
  transactionId: number | null;
  source: string | null;
}

/** Un mese del grafico redditi. I rimborsi a scadenza NON sono conteggiati qui. */
export interface MonthlyIncomeTotal {
  month: string;
  gross: Amount;
  // Confermato e proiettato separati: la UI li distingue col canale TEXTURE
  // (tratteggio), non con una seconda tinta.
  confirmed: Amount;
  projected: Amount;
}

export interface CalendarResponse {
  from: DateString;
  to: DateString;
  baseCcy?: string;
  events: CalendarEvent[];
  monthlyTotals: MonthlyIncomeTotal[];
  warnings: Warning[];
}

/** POST /api/calendar/:id/confirm: l'evento aggiornato e il movimento creato. */
export interface ConfirmEventResponse {
  event: {
    id: number;
    instrumentId: number;
    kind: string;
    status: string;
    exDate: DateString | null;
    payDate: DateString | null;
    amountPerUnit: Amount;
    currency: string;
    splitRatio: Amount;
    source: string | null;
    transactionId: number | null;
  };
  transaction: Transaction;
}

// ---------------------------------------------------------------------------
// Cambi, sistema, sessione
// ---------------------------------------------------------------------------

export interface FxRate {
  date: DateString;
  baseCcy: string;
  quoteCcy: string;
  rate: string;
  source: string | null;
  isFilled: boolean;
  fetchedAt: string | null;
}

export interface FxResponse {
  base: string;
  /** La convenzione va DICHIARATA: è la fonte di errore numero uno in multivaluta. */
  convention: string;
  items: FxRate[];
  coverage: unknown;
}

/** Lo stato di /api/system/status. */
export interface SystemStatus {
  ready: boolean;
  startedAt: string;
  db: { configured: boolean; connected: boolean; error: string | null };
  migrations: {
    applied: string[];
    pending: string[];
    known: string[];
    mismatched: string[];
    error: string | null;
  };
  scheduler: {
    enabled: boolean;
    leader: boolean;
    timezone: string;
    lastRuns: Record<string, unknown>;
  };
  provider: string;
  time: { utc: string; local: string; tzEnv: string | null };
  warnings: Array<{ code: string; details?: unknown }>;
}

/** GET /api/auth/me: la sonda con cui la SPA scopre se ha una sessione. */
export interface AuthMe {
  authenticated: boolean;
  reason?: string;
  expiresAt?: string;
}

/** La risposta di un'azione accodata (refresh prezzi, backfill). */
export interface AcceptedJob {
  accepted: boolean;
  jobId: string | number | null;
  scope?: string;
}
