// I payload dell'API, come li vede la SPA.
//
// Sono lo specchio di `src/http/serialize.ts` sul server (che è l'unico posto che
// decide la forma delle risposte): se cambia lì, va cambiato qui. Non c'è
// generazione automatica di proposito - il server e la SPA sono due pacchetti
// separati, e un tipo scritto a mano che qualcuno deve aggiornare è più onesto di
// uno generato che nessuno guarda.
//
// **Ogni importo è una STRINGA**, mai un number: il denaro viaggia come stringa
// decimale da un capo all'altro (docs/decisions.md §1). Se vedi uno di questi
// campi dentro un'espressione aritmetica, è un bug.

/** Importo/quantità/prezzo: stringa decimale, oppure null se non calcolabile. */
export type Amount = string | null;
/** Data "YYYY-MM-DD". */
export type DateString = string;

export interface InstrumentRef {
  id: number;
  name: string;
  ticker: string | null;
  isin: string | null;
  assetClass: string | null;
  quoteConvention?: string | null;
  faceValue?: Amount;
  issuer?: string | null;
}

export interface Instrument extends InstrumentRef {
  currency: string;
  exchange?: string | null;
  priceSource?: string | null;
  notes?: string | null;
  active?: boolean;
  metadata?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
  /** Presente solo per le obbligazioni (vedi withBondDetails sul server). */
  bond?: {
    faceValue: Amount;
    couponRate: Amount;
    couponFrequency: number | null;
    firstCouponDate: DateString | null;
    maturityDate: DateString | null;
    dayCount: string | null;
    accruedInterest?: Amount;
    currentYield?: Amount;
    nextCoupon?: { payDate: DateString; amountPer100: Amount } | null;
  };
}

export interface Portfolio {
  id: number;
  name: string;
  baseCcy: string;
  broker: string | null;
  createdAt?: string;
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
  nominal?: Amount;
  instrument?: InstrumentRef | null;
}

/** Una riga di /api/portfolio/positions. */
export interface PositionRow {
  instrument: InstrumentRef;
  currency: string;
  quantity: Amount;
  avgCost: Amount;
  costBasis: Amount;
  price: Amount;
  priceDate: DateString | null;
  priceSource: string | null;
  stale: boolean;
  priced: boolean;
  marketValue: Amount;
  marketValueBase: Amount;
  accruedInterest: Amount;
  unrealizedPnl: Amount;
  unrealizedPnlPct: Amount;
  realizedPnl: Amount;
  incomeGross: Amount;
  incomeNet: Amount;
  taxWithheld: Amount;
  feesTotal: Amount;
  dayChange: Amount;
  dayChangePct: Amount;
  weight: Amount;
  nominal?: Amount;
  fxRate: Amount;
  warnings?: Warning[];
}

/** I totali di /api/portfolio/summary. */
export interface Summary {
  asOf: DateString;
  portfolioId: number;
  baseCcy: string;
  marketValue: Amount;
  accruedInterest: Amount;
  totalValue: Amount;
  costBasis: Amount;
  unrealizedPnl: Amount;
  unrealizedPnlPct: Amount;
  realizedPnl: Amount;
  incomeGross: Amount;
  incomeNet: Amount;
  taxWithheld: Amount;
  feesTotal: Amount;
  dayChange: Amount;
  dayChangePct: Amount;
  netInvested?: Amount;
  partial?: boolean;
  warnings?: Warning[];
}

/** Un punto di /api/portfolio/value-series. */
export interface SeriesPoint {
  date: DateString;
  value: Amount;
  cost?: Amount;
  netInvested?: Amount;
  /** true quando il punto è calcolato con dati incompleti (prezzo o cambio assenti). */
  partial?: boolean;
}

/** Un gruppo di /api/portfolio/allocation. */
export interface AllocationGroup {
  key: string;
  label: string;
  value: Amount;
  weight: Amount;
}

/** Una voce di /api/calendar. */
export interface CalendarEvent {
  id: number;
  instrumentId: number;
  instrument: InstrumentRef;
  kind: string;
  status: string;
  exDate: DateString | null;
  payDate: DateString | null;
  amountPerUnit: Amount;
  currency: string;
  splitRatio: Amount;
  source: string | null;
  transactionId: number | null;
  gross?: Amount;
  grossBase?: Amount;
  quantity?: Amount;
  confidence?: string;
}

/** Un avvertimento che accompagna un risultato invece di interromperlo. */
export interface Warning {
  code: string;
  message?: string;
  instrumentId?: number | null;
  instrumentName?: string | null;
  currency?: string | null;
  date?: DateString | null;
  pending?: boolean;
  details?: unknown;
}

/** Il rendimento di /api/portfolio/returns. */
export interface Returns {
  twr: { total: Amount; annualized: Amount };
  xirr: Amount;
  byYear?: Array<{ year: string; twr: Amount; xirr: Amount }>;
  flows?: Array<{ date: DateString; amount: Amount; type?: string }>;
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
