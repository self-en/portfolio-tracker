// Interfaccia provider + factory.
//
// Tutto restituisce forme NORMALIZZATE con numerici come stringa, così passare a
// un provider a pagamento (eodhd, ecc.) tocca un solo file.
//
//   getQuotes(symbols)              -> [{ symbol, price, currency, previousClose, marketState, quoteTime }]
//   getHistory(symbol, from, to)    -> { currency, bars: [{ date, open, high, low, close, adjClose, volume }] }
//   getCorporateActions(symbol,f,t) -> { dividends: [{ exDate, amount }], splits: [{ date, ratio }] }
//   getUpcomingDividend(symbol)     -> { exDate, payDate, amountPerUnit } | null
//   resolveSymbol(query)            -> [{ symbol, name, exchange, quoteType, currency, score }]
//   getFundamentals(symbol)         -> { profile, valuation, profitability, balance, ... } | null
import config from "../config";
import { createYahooProvider } from "./yahooProvider";
import type {
  NormalizedBar,
  NormalizedEvents,
  NormalizedFundamentals,
  NormalizedQuote,
  NormalizedSearchHit,
  UpcomingDividend,
} from "./yahooProvider";

/** Provider vuoto: nessuna chiamata di rete. È il comportamento per i bond. */
function createManualProvider(): MarketProvider {
  return {
    name: "manual",
    async getQuotes() {
      return [];
    },
    async getHistory() {
      return { currency: null, bars: [] };
    },
    async getCorporateActions() {
      return { dividends: [], splits: [] };
    },
    async getUpcomingDividend() {
      return null;
    },
    async resolveSymbol() {
      return [];
    },
    // Nessun fondamentale senza rete: l'analisi lavorerà sui soli dati nostri e lo
    // dichiarerà. È il caso NORMALE per le obbligazioni, non un errore.
    async getFundamentals() {
      return null;
    },
  };
}

/**
 * Il contratto che il resto dell'app usa. Dichiararlo qui e' cio' che rende il
 * provider "manual" un sostituto legittimo di quello Yahoo invece di un oggetto
 * che somiglia abbastanza.
 */
export interface MarketProvider {
  name: string;
  getQuotes(symbols: ReadonlyArray<string | null | undefined>): Promise<NormalizedQuote[]>;
  getHistory(
    symbol: string,
    from: string,
    to: string
  ): Promise<{ currency: string | null; bars: NormalizedBar[]; events?: NormalizedEvents }>;
  getCorporateActions(symbol: string, from: string, to: string): Promise<NormalizedEvents>;
  getUpcomingDividend(symbol: string): Promise<UpcomingDividend | null>;
  resolveSymbol(query: string): Promise<NormalizedSearchHit[]>;
  /** `null` quando il provider non ha fondamentali da dare (provider `manual`). */
  getFundamentals(symbol: string): Promise<NormalizedFundamentals | null>;
}

let cached: MarketProvider | null = null;

function createProvider(cfg: typeof config = config): MarketProvider {
  if (cached) return cached;
  const name = (cfg.market?.provider || "yahoo").toLowerCase();
  if (name === "manual") {
    cached = createManualProvider();
  } else {
    // Require lazy: in `manual` non si carica yahoo-finance2 (e con esso zod,
    // tough-cookie e @modelcontextprotocol/sdk, che sono dipendenze RUNTIME e
    // pesano sulla memoria del pod).
    cached = createYahooProvider(cfg);
  }
  return cached;
}

/** Solo per i test. */
function _reset() {
  cached = null;
}

export { createProvider, createManualProvider, _reset };
