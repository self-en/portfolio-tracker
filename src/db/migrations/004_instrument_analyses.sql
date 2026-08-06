-- Analisi di bilancio degli strumenti, generate con Claude.
--
-- Perché si persistono invece di ricalcolarle a ogni apertura della pagina: ogni
-- analisi è una chiamata a pagamento, e soprattutto è una FOTOGRAFIA — è stata
-- fatta su quel bilancio, con quel prezzo, con quella posizione in portafoglio.
-- Rigenerarla domani non la riproduce: dà un'altra analisi. Per questo `context`
-- conserva lo snapshot dei dati di ingresso: senza, tra sei mesi il verdetto
-- resterebbe leggibile ma non più interpretabile.
--
-- ON DELETE CASCADE: le analisi non devono impedire di cancellare uno strumento.
-- Il 409 su DELETE /instruments/:id difende i MOVIMENTI, che sono inseriti a mano e
-- irrecuperabili; un'analisi si rifà.
--
-- Gli "enum" sono CHECK constraint come nel resto dello schema. Qui hanno un ruolo
-- in più: sono la seconda guardia sull'output del modello (la prima è lo schema
-- dell'output strutturato, la seconda la validazione in src/ai/). Un verdetto fuori
-- lista è un bug da vedere, non un valore da salvare.

CREATE TABLE IF NOT EXISTS instrument_analyses (
  id            SERIAL PRIMARY KEY,
  instrument_id INTEGER NOT NULL REFERENCES instruments(id) ON DELETE CASCADE,
  model         TEXT NOT NULL,
  effort        TEXT,
  verdict       TEXT NOT NULL CHECK (verdict IN
                  ('COMPRARE','MANTENERE','RIDURRE','EVITARE','APPROFONDIRE')),
  confidence    TEXT NOT NULL CHECK (confidence IN ('ALTA','MEDIA','BASSA')),
  headline      TEXT NOT NULL,
  -- L'output strutturato completo: salute finanziaria, valutazione, punti di forza,
  -- rischi, cosa monitorare, dati mancanti.
  analysis      JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Lo snapshot dei dati passati al modello.
  context       JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Token consumati: è l'unico modo di sapere quanto è costata la funzione.
  usage         JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Unico su (strumento, istante): due analisi dello stesso titolo nello stesso
  -- istante non esistono, e questo vincolo è ciò che rende l'IMPORT IDEMPOTENTE —
  -- reimportare lo stesso backup non moltiplica le analisi (ON CONFLICT DO NOTHING
  -- in src/repo/importer.ts).
  --
  -- Dichiarato come CONSTRAINT e non come CREATE UNIQUE INDEX: l'inferenza di
  -- ON CONFLICT funziona con entrambi su Postgres, ma pg-mem — con cui girano i
  -- test in locale — riconosce solo i vincoli di tabella e su un indice separato
  -- risponde "no unique or exclusion constraint matching the ON CONFLICT
  -- specification". Stesso schema, stessa semantica, un mock in meno da aggirare.
  CONSTRAINT instrument_analyses_dedup_uq UNIQUE (instrument_id, created_at)
);

-- L'accesso è sempre "l'ultima analisi di questo strumento".
CREATE INDEX IF NOT EXISTS instrument_analyses_latest_ix
  ON instrument_analyses (instrument_id, created_at DESC);
