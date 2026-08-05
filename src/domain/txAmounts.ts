// Calcolo di gross_amount / net_amount / rateo per una transazione.
//
// Vive in domain/ (puro) perché è la stessa matematica che alimenta
// POST /api/transactions e POST /api/transactions/preview. Duplicarla in React
// significherebbe due implementazioni che divergono al primo caso limite —
// tipicamente il rateo obbligazionario.
import { D, d, ZERO, isBlank } from "./money";
import * as positions from "./positions";
import * as bonds from "./bonds";
import type { DomainWarning, InstrumentLike, TxLike } from "./types";

/** Tipi in cui l'importo è inserito direttamente dall'utente (non derivato da qty×prezzo). */
const AMOUNT_TYPES = new Set([
  "DIVIDEND",
  "COUPON",
  "INTEREST",
  "FEE",
  "TAX",
  "DEPOSIT",
  "WITHDRAWAL",
  "RETURN_OF_CAPITAL",
]);

/** Segno dell'effetto di cassa per tipo, come richiesto dal CHECK tx_net_sign. */
const NEGATIVE_TYPES = new Set(["BUY", "FEE", "TAX", "WITHDRAWAL"]);

/**
 * Calcola gli importi derivati di una transazione.
 *
 * @param {object} input campi inseriti dall'utente (numerici come stringa)
 * @param {object|null} instrument metadati dello strumento (per bond e nominale)
 * @returns {{grossAmount, netAmount, accruedInterest, quantity, nominal, autoAccrued, warnings}}
 *   tutti i numerici come STRINGA.
 */
function computeAmounts(input: TxLike, instrument: InstrumentLike | null = null) {
  const type = input.type;
  const warnings: DomainWarning[] = [];
  const fees = d(input.fees);
  const taxes = d(input.taxes);

  const isBond =
    instrument &&
    (instrument.quoteConvention === "PCT_OF_NOMINAL" || instrument.assetClass === "BOND");
  const faceValue = d(instrument?.faceValue, 1);

  // --- SPLIT: nessun movimento di cassa ---
  if (type === "SPLIT") {
    return {
      grossAmount: null,
      netAmount: "0",
      accruedInterest: "0",
      quantity: null,
      nominal: null,
      autoAccrued: false,
      warnings,
    };
  }

  // --- Tipi a importo diretto ---
  if (AMOUNT_TYPES.has(type)) {
    // L'utente inserisce il LORDO; la ritenuta è un campo separato (requisito
    // esplicito), quindi il netto è una sottrazione, non un altro input.
    const gross = d(input.grossAmount);
    let net;
    if (type === "FEE" || type === "TAX" || type === "WITHDRAWAL") {
      net = gross.abs().negated();
    } else {
      // DIVIDEND / COUPON / INTEREST / DEPOSIT / RETURN_OF_CAPITAL
      net = gross.abs().minus(taxes).minus(fees);
      if (net.lt(0)) {
        // Il CHECK del database rifiuterebbe un netto negativo su questi tipi, e
        // comunque significa che ritenuta + commissioni superano il lordo: quasi
        // sempre un errore di inserimento.
        warnings.push({
          code: "net_negative",
          message: `ritenuta e commissioni (${taxes.plus(fees).toFixed()}) superano il lordo (${gross.abs().toFixed()})`,
        });
      }
    }
    return {
      grossAmount: gross.abs().toFixed(),
      netAmount: net.toFixed(),
      accruedInterest: "0",
      quantity: isBlank(input.quantity) ? null : d(input.quantity).toFixed(),
      nominal: null,
      autoAccrued: false,
      warnings,
    };
  }

  // --- BUY / SELL ---
  if (type !== "BUY" && type !== "SELL") {
    warnings.push({ code: "unknown_type", message: `tipo non gestito: ${type}` });
    return {
      grossAmount: null,
      netAmount: "0",
      accruedInterest: "0",
      quantity: null,
      nominal: null,
      autoAccrued: false,
      warnings,
    };
  }

  // Il form obbligazionario accetta il NOMINALE (quello che mostra il broker) e ne
  // deriva la quantità, mostrando entrambi.
  let quantity;
  let nominal = null;
  if (isBond && !isBlank(input.nominal)) {
    nominal = d(input.nominal);
    quantity = faceValue.isZero() ? ZERO : nominal.div(faceValue);
  } else {
    quantity = d(input.quantity);
    if (isBond) nominal = quantity.times(faceValue);
  }

  const price = d(input.price);
  const gross = positions.tradeGross({ quantity, price }, instrument);

  // Rateo: se l'utente non lo fornisce, si calcola dallo scadenzario. Il calcolo
  // vive QUI e non in React, così il form mostra un valore che il server confermerà.
  let accrued = ZERO;
  let autoAccrued = false;
  if (isBond) {
    if (!isBlank(input.accruedInterest)) {
      accrued = d(input.accruedInterest);
    } else if (instrument?.couponFrequency && instrument?.maturityDate) {
      try {
        const settle = input.settleDate || input.tradeDate;
        const acc = bonds.accruedInterest(instrument, settle);
        // accruedPer100 è per 100 di nominale → importo = nominale × rateo/100.
        accrued = d(nominal ?? quantity.times(faceValue)).times(d(acc.accruedPer100)).div(100);
        autoAccrued = true;
      } catch {
        accrued = ZERO;
      }
    }
  }

  // Effetto di cassa. Il rateo si PAGA in acquisto e si INCASSA in vendita: in
  // entrambi i casi ha lo stesso segno del corpo dell'operazione.
  const net =
    type === "BUY"
      ? gross.plus(fees).plus(taxes).plus(accrued).negated()
      : gross.minus(fees).minus(taxes).plus(accrued);

  if (type === "SELL" && net.lt(0)) {
    warnings.push({
      code: "net_negative",
      message: "commissioni e imposte superano il ricavo della vendita",
    });
  }

  return {
    grossAmount: gross.toDecimalPlaces(6, D.ROUND_HALF_EVEN).toFixed(),
    netAmount: net.toDecimalPlaces(6, D.ROUND_HALF_EVEN).toFixed(),
    accruedInterest: accrued.toDecimalPlaces(6, D.ROUND_HALF_EVEN).toFixed(),
    quantity: quantity.toDecimalPlaces(8, D.ROUND_HALF_EVEN).toFixed(),
    nominal: nominal === null ? null : nominal.toDecimalPlaces(6, D.ROUND_HALF_EVEN).toFixed(),
    autoAccrued,
    warnings,
  };
}

export { computeAmounts, AMOUNT_TYPES, NEGATIVE_TYPES };
