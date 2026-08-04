// Helper per costruire clausole SQL.

/**
 * Costruisce una clausola `IN ($1, $2, …)` accodando i valori a `params`.
 *
 * Perché non `= ANY($1::int[])`, che sarebbe un solo parametro: Postgres riscrive
 * `IN (lista)` esattamente in `= ANY(array)` e i due piani sono identici, ma la
 * forma espansa è PORTABILE — pg-mem, con cui questo layer viene testato in locale
 * (qui non c'è Postgres), restituisce zero righe da `= ANY(array)` quando la colonna
 * ha un indice unique. Un bug del mock che ci costerebbe in silenzio ogni query che
 * carica più strumenti insieme.
 *
 * La lista è limitata dai parametri per statement di Postgres (65535): a queste
 * dimensioni — decine di strumenti — non è un vincolo reale.
 *
 * @returns {string} il frammento `IN ($3, $4)`, oppure `IN (NULL)` se la lista è vuota
 */
function inList(params, values) {
  if (!values || values.length === 0) return "IN (NULL)";
  const placeholders = values.map((v) => {
    params.push(v);
    return `$${params.length}`;
  });
  return `IN (${placeholders.join(", ")})`;
}

module.exports = { inList };
