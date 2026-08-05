// Sotto `strict`, la variabile di un catch e' `unknown`: giusto, perche' in
// JavaScript si puo' lanciare qualunque cosa. Questi helper sono l'unico posto che
// fa la conversione, invece di spargere `(err as Error)` in ottanta catch - un
// cast ripetuto e' una convenzione non verificata, una funzione e' un
// comportamento definito (una stringa lanciata, un oggetto senza `message`, null:
// qui producono tutti qualcosa di leggibile in un log).
export function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}

export function errStack(err: unknown): string | undefined {
  return err instanceof Error ? err.stack : undefined;
}

/** Il `code` di un errore di sistema (es. MODULE_NOT_FOUND, ECONNREFUSED). */
export function errCode(err: unknown): string | undefined {
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}
