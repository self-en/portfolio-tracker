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

async function tolerant(label, fn) {
  try {
    return await fn();
  } catch (e) {
    if (e?.name === "FailedYahooValidationError" && e.result !== undefined) {
      logger.warn(
        { label, errors: (e.errors || []).slice(0, 3).map((x) => String(x).slice(0, 200)) },
        "[market] drift schema yahoo — uso il risultato non validato"
      );
      return e.result;
    }
    throw e;
  }
}

export { tolerant };
