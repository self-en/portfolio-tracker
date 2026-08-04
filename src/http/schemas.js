// Schemi zod condivisi. Denaro e quantità sono STRINGHE decimali validate con
// regex, mai passate da parseFloat (docs/decisions.md §1).
const { z, decimalString, dateString, currency } = require("./validate");

const ASSET_CLASSES = ["EQUITY", "ETF", "BOND", "FUND", "CRYPTO", "CASH"];
const TX_TYPES = [
  "BUY",
  "SELL",
  "DIVIDEND",
  "COUPON",
  "INTEREST",
  "FEE",
  "TAX",
  "SPLIT",
  "DEPOSIT",
  "WITHDRAWAL",
  "RETURN_OF_CAPITAL",
];
const PRICE_SOURCES = ["yahoo", "manual"];
const QUOTE_CONVENTIONS = ["PRICE", "PCT_OF_NOMINAL"];
const DAY_COUNTS = ["ACT/ACT-ICMA", "30E/360", "ACT/365F", "ACT/360"];
const COUPON_FREQUENCIES = [0, 1, 2, 4, 12];

const nullableDate = () => dateString().nullish();
const nullableDecimal = (opts) => decimalString(opts).nullish();

// --- Strumenti ---

const instrumentBase = {
  assetClass: z.enum(ASSET_CLASSES),
  name: z.string().trim().min(1, "il nome è obbligatorio").max(200),
  ticker: z.string().trim().max(40).nullish(),
  isin: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}[A-Z0-9]{9}\d$/, "ISIN non valido (12 caratteri, es. IE00B4L5Y983)")
    .nullish(),
  exchange: z.string().trim().max(40).nullish(),
  currency: currency(),
  priceSource: z.enum(PRICE_SOURCES).default("yahoo"),
  quoteConvention: z.enum(QUOTE_CONVENTIONS).default("PRICE"),
  faceValue: nullableDecimal({ positive: true }),
  // FRAZIONE annua: 0.0345 = 3,45%. Il form lo converte da percentuale.
  couponRate: nullableDecimal({ nonNegative: true }),
  couponFrequency: z
    .union([z.number(), z.string()])
    .transform((v) => Number(v))
    .refine((v) => COUPON_FREQUENCIES.includes(v), "frequenza cedolare non valida (0, 1, 2, 4, 12)")
    .nullish(),
  firstCouponDate: nullableDate(),
  maturityDate: nullableDate(),
  dayCount: z.enum(DAY_COUNTS).nullish(),
  issuer: z.string().trim().max(200).nullish(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  notes: z.string().max(4000).nullish(),
  active: z.boolean().default(true),
};

/**
 * Le stesse invarianti dei CHECK constraint, applicate PRIMA di toccare il
 * database: un 422 con l'elenco dei campi è utile, un 23514 su un nome di
 * constraint non lo è.
 */
function refineInstrument(schema) {
  return schema
    .refine((v) => v.ticker || v.isin, {
      message: "serve almeno un ticker o un ISIN",
      path: ["ticker"],
    })
    .refine(
      (v) =>
        v.assetClass !== "BOND" ||
        (v.faceValue != null && v.couponFrequency != null && v.maturityDate != null),
      {
        message: "un'obbligazione richiede valore facciale, frequenza cedolare e scadenza",
        path: ["faceValue"],
      }
    )
    .refine(
      (v) =>
        v.assetClass !== "BOND" ||
        v.couponFrequency === 0 ||
        (v.couponRate != null && v.firstCouponDate != null),
      {
        message: "un'obbligazione con cedola richiede tasso cedolare e data della prima cedola",
        path: ["couponRate"],
      }
    )
    .refine(
      (v) =>
        !v.firstCouponDate || !v.maturityDate || v.firstCouponDate <= v.maturityDate,
      { message: "la prima cedola non può cadere dopo la scadenza", path: ["firstCouponDate"] }
    )
    .refine((v) => v.priceSource !== "yahoo" || v.assetClass !== "BOND" || v.ticker, {
      message:
        "le obbligazioni non hanno copertura di mercato: usa price_source 'manual' oppure indica un ticker",
      path: ["priceSource"],
    });
}

const createInstrument = refineInstrument(z.object(instrumentBase));
const updateInstrument = z.object(instrumentBase).partial();

// --- Transazioni ---

const transactionBase = {
  portfolioId: z.coerce.number().int().positive().nullish(),
  instrumentId: z.coerce.number().int().positive().nullish(),
  type: z.enum(TX_TYPES),
  tradeDate: dateString(),
  settleDate: nullableDate(),
  quantity: nullableDecimal({ positive: true }),
  // Nominale: input alternativo alla quantità per le obbligazioni (è ciò che
  // mostra il broker). Il server ne deriva la quantità.
  nominal: nullableDecimal({ positive: true }),
  price: nullableDecimal({ nonNegative: true }),
  grossAmount: nullableDecimal(),
  fees: decimalString({ nonNegative: true }).default("0"),
  taxes: decimalString({ nonNegative: true }).default("0"),
  accruedInterest: nullableDecimal(),
  tradeCcy: currency().default("EUR"),
  fxRate: nullableDecimal({ positive: true }),
  splitRatio: nullableDecimal({ positive: true }),
  note: z.string().max(2000).nullish(),
  externalRef: z.string().max(200).nullish(),
};

function refineTransaction(schema) {
  return schema
    .refine((v) => ["DEPOSIT", "WITHDRAWAL"].includes(v.type) || v.instrumentId != null, {
      message: "questo tipo di movimento richiede uno strumento",
      path: ["instrumentId"],
    })
    .refine(
      (v) =>
        !["BUY", "SELL"].includes(v.type) ||
        ((v.quantity != null || v.nominal != null) && v.price != null),
      {
        message: "acquisto e vendita richiedono quantità (o nominale) e prezzo",
        path: ["quantity"],
      }
    )
    .refine((v) => v.type !== "SPLIT" || v.splitRatio != null, {
      message: "uno split richiede il rapporto di conversione",
      path: ["splitRatio"],
    })
    .refine(
      (v) =>
        ![
          "DIVIDEND",
          "COUPON",
          "INTEREST",
          "FEE",
          "TAX",
          "DEPOSIT",
          "WITHDRAWAL",
          "RETURN_OF_CAPITAL",
        ].includes(v.type) || v.grossAmount != null,
      { message: "questo tipo di movimento richiede un importo lordo", path: ["grossAmount"] }
    )
    .refine((v) => !v.settleDate || v.settleDate >= v.tradeDate, {
      message: "la data di regolamento non può precedere quella di negoziazione",
      path: ["settleDate"],
    });
}

const createTransaction = refineTransaction(z.object(transactionBase));
// PATCH: `type` e `tradeDate` restano obbligatori, perché il ricalcolo degli
// importi ha bisogno del quadro completo. Il route ricompone il record e lo
// rivalida con lo schema pieno.
const updateTransaction = z.object(transactionBase).partial();
const previewTransaction = createTransaction;

// --- Query string ---

const listTransactionsQuery = z.object({
  portfolioId: z.coerce.number().int().positive().optional(),
  instrumentId: z.coerce.number().int().positive().optional(),
  type: z
    .union([z.string(), z.array(z.string())])
    .transform((v) => (Array.isArray(v) ? v : v.split(",")).filter(Boolean))
    .optional(),
  from: dateString().optional(),
  to: dateString().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  cursor: z.string().optional(),
});

const listInstrumentsQuery = z.object({
  q: z.string().trim().max(100).optional(),
  assetClass: z.enum(ASSET_CLASSES).optional(),
  active: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
  priceSource: z.enum(PRICE_SOURCES).optional(),
});

const RANGES = ["1M", "3M", "6M", "YTD", "1Y", "5Y", "ALL"];
const GRANULARITIES = ["auto", "day", "week", "month"];

const portfolioQuery = z.object({
  portfolioId: z.coerce.number().int().positive().optional(),
  asOf: dateString().optional(),
  includeAccrued: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
});

const seriesQuery = portfolioQuery.extend({
  range: z.enum(RANGES).default("1Y"),
  granularity: z.enum(GRANULARITIES).default("auto"),
});

const manualPriceBody = z.object({
  date: dateString(),
  close: decimalString({ nonNegative: true }),
});

const confirmEventBody = z.object({
  portfolioId: z.coerce.number().int().positive().optional(),
  // Il lordo arriva precompilato dallo scadenzario ma resta modificabile: lo
  // scadenzario è una proiezione, l'estratto conto è la verità.
  grossAmount: nullableDecimal(),
  taxes: decimalString({ nonNegative: true }).default("0"),
  fees: decimalString({ nonNegative: true }).default("0"),
  tradeDate: nullableDate(),
  fxRate: nullableDecimal({ positive: true }),
  note: z.string().max(2000).nullish(),
});

module.exports = {
  ASSET_CLASSES,
  TX_TYPES,
  PRICE_SOURCES,
  QUOTE_CONVENTIONS,
  DAY_COUNTS,
  COUPON_FREQUENCIES,
  RANGES,
  GRANULARITIES,
  createInstrument,
  updateInstrument,
  refineInstrument,
  createTransaction,
  updateTransaction,
  previewTransaction,
  refineTransaction,
  listTransactionsQuery,
  listInstrumentsQuery,
  portfolioQuery,
  seriesQuery,
  manualPriceBody,
  confirmEventBody,
};
