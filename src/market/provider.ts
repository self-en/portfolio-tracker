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
import config from "../config";
import { createYahooProvider } from "./yahooProvider";

/** Provider vuoto: nessuna chiamata di rete. È il comportamento per i bond. */
function createManualProvider() {
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
  };
}

let cached = null;

function createProvider(cfg = config) {
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
