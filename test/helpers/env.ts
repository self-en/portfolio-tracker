// L'ambiente dei test, impostato come EFFETTO DI IMPORT.
//
// Va importato per PRIMO da ogni test che carica src/config (direttamente o
// tirandosi dietro un repo, l'app, o il pool): `config.ts` legge process.env al
// momento del load e va in "locked mode" se APP_PASSWORD o SESSION_SECRET
// mancano. In locked mode l'app risponde 503 not_configured a tutto, quindi il
// test fallisce in un modo che non somiglia per niente alla causa.
//
// Sta in un modulo e non in righe `process.env.X = ...` in testa al file di test
// perché TypeScript ISSA gli import sopra qualsiasi altra istruzione: con
// l'assegnamento inline il config verrebbe caricato prima, e questo è
// esattamente il bug che si è visto convertendo i test da require() a import
// (18 fallimenti, tutti not_configured). L'ordine RELATIVO tra import invece è
// garantito, quindi un import è l'unico modo di arrivare prima del config.

/** Esportata perché i test che fanno login la mandano nel body: una sola verità. */
export const TEST_PASSWORD = "test-pw";

process.env.APP_PASSWORD = TEST_PASSWORD;
process.env.SESSION_SECRET = "0123456789abcdef0123456789abcdef0123456789";

// Fa credere a config.ts che un database ci sia: conta solo che sia non vuoto
// (`hasDiscretePg = !!process.env.PGHOST`). La connessione vera non viene mai
// aperta — i test sostituiscono il pool con quello di pg-mem via `_setPool`.
process.env.PGHOST = "memdb";

// Nessun test vuole il cron: partirebbe in mezzo alle asserzioni.
process.env.SCHEDULER_ENABLED = "false";
