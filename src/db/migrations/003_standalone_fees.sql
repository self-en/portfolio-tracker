-- FEE e TAX ammesse SENZA strumento.
--
-- Il CHECK originale esigeva un instrument_id per tutto tranne DEPOSIT e WITHDRAWAL,
-- ma un bollo, un canone di custodia o un'imposta di conto non appartengono a un
-- titolo specifico — ed è il caso più comune di commissione standalone. Il vincolo
-- rendeva impossibile registrarli senza attaccarli a un titolo arbitrario, che
-- avrebbe falsato le commissioni per posizione.
--
-- DROP + ADD invece di ALTER: Postgres non offre un modo per modificare un CHECK in
-- posizione. `IF EXISTS` rende la migrazione ri-eseguibile su uno schema
-- parzialmente applicato.

ALTER TABLE transactions DROP CONSTRAINT IF EXISTS tx_needs_instrument;

ALTER TABLE transactions ADD CONSTRAINT tx_needs_instrument CHECK (
  type IN ('DEPOSIT','WITHDRAWAL','FEE','TAX') OR instrument_id IS NOT NULL);
