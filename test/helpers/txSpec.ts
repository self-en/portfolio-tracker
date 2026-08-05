/**
 * Ciò che un test dichiara di una transazione: tutto opzionale tranne tipo e data,
 * il resto lo riempie il builder `tx()` di ciascun file coi propri default.
 *
 * I nomi sono in snake_case perché questa è la RIGA come arriva dal database:
 * normalizzarla in camelCase è compito di `buildPositions`, ed è parte di ciò che
 * questi test verificano. Passare direttamente un oggetto camelCase proverebbe
 * qualcosa di più debole.
 *
 * Sta qui, e non in uno dei due file, perché positions.test e valuation.test
 * costruiscono ledger con la stessa forma ma default diversi (solo il primo ha
 * bisogno di `portfolio_id`): condividere il TIPO evita la copia lunga, tenere due
 * builder evita di cambiare i default di un test per comodità dell'altro.
 */
export interface TxSpec {
  id?: number;
  portfolio_id?: number;
  instrument_id?: number | null;
  type: string;
  trade_date: string;
  quantity?: string | null;
  price?: string | null;
  gross_amount?: string | null;
  fees?: string | null;
  taxes?: string | null;
  accrued_interest?: string | null;
  net_amount?: string | null;
  trade_ccy?: string | null;
  fx_rate?: string | null;
  split_ratio?: string | null;
}
