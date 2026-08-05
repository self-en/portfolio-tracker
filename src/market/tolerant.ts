// Le 12 righe a maggior leva di tutto il progetto.
//
// Il drift delle risposte di Yahoo fa *lanciare* la validazione zod di
// yahoo-finance2 (`FailedYahooValidationError`), MA l'errore porta con sé il
// payload coercito in `err.result` — più l'elenco dei problemi in `err.errors`.
//
// È l'escape hatch che rende il drift sopravvivibile: senza, un campo aggiunto o
// rinominato da Yahoo trasforma una dashboard funzionante in una pagina rotta.
// Con, degrada a un warning nei log.
import logger from "../logger";

/** La forma dell'errore di validazione di yahoo-finance2 che ci interessa. */
interface YahooValidationError {
  name?: string;
  result?: unknown;
  errors?: unknown[];
}

async function tolerant<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const ve = e as YahooValidationError;
    if (ve?.name === "FailedYahooValidationError" && ve.result !== undefined) {
      logger.warn(
        { label, errors: (ve.errors || []).slice(0, 3).map((x) => String(x).slice(0, 200)) },
        "[market] drift schema yahoo — uso il risultato non validato"
      );
      // Il payload coercito NON e' validato: e' esattamente il punto di questa
      // funzione, e i normalizzatori a valle sono scritti per essere tolleranti.
      return ve.result as T;
    }
    throw e;
  }
}

export { tolerant };
