# Istruzioni operative

## Dichiara sempre le variabili d'ambiente che introduci

Se il codice ha bisogno di un valore che una **persona** deve decidere (una password,
una credenziale che costa), nello stesso commit:

1. dichiaralo in `self-en.json` con `label` e `description` in italiano — le legge una
   persona non tecnica nel form "Configurazione" di nedo;
2. leggilo da `src/config.ts`, che è l'unico modulo autorizzato a toccare
   `process.env` (è dichiarato come `configModule` nel contratto, quindi esente dal
   controllo);
3. esegui `npm run check:contract` (è uno step della CI: se fallisce, non viene
   pubblicata nessuna immagine e la versione non si aggiorna).

Se invece è una **manopola** con un default sensato (un fuso, una dimensione di pool,
un timeout), resta leggibile dall'ambiente ma **fuori** dal form: quindici campi da non
toccare rendono invisibili i due che contano. Regola pratica: *se l'app non parte senza
quel valore, o se costa soldi, va nel form; altrimenti no.*

Non modificare `src/platform/config.ts` né `chart/templates/app-env-secret.yaml`: sono
gestiti dalla piattaforma (marcati `self-en-contract: <n>`) e vengono riscritti. Non
mettere segreti in `chart/values.yaml` né dichiararli come `env:` nel Deployment: un
`env:` esplicito **vince** su `envFrom` e zittirebbe in silenzio la pagina
Configurazione.

Se l'app non può funzionare senza una variabile, **non farla crashare e non far fallire
`/healthz`**: il locked mode (503 `not_configured` su `/api/*`) è la degradazione
voluta, perché un crashloop su questa piattaforma non lascia log leggibili nella UI.

## Tieni aggiornata la documentazione — nel file giusto

Dopo **ogni modifica rilevante** aggiorna la documentazione nella stessa unità di
lavoro (stesso commit) della modifica. È una regola vincolante, non un promemoria.

Questo repository ha **quattro** tipi di documento, e sbagliare quale si aggiorna è il
modo in cui la documentazione diventa inaffidabile:

| Cosa hai scritto | Dove va |
|---|---|
| Cosa fa l'app, gli endpoint, la configurazione, cosa NON fa: roba che una **persona** legge | `README.md` |
| Il **perché** di una convenzione, un'alternativa scartata, una verifica fatta sul campo | `docs/decisions.md`, come paragrafo numerato |
| Le regole locali di una cartella, quelle che servono **mentre** la si modifica | il `CLAUDE.md` di quella cartella: `src/`, `src/domain/`, `web/`, `test/`, `chart/` |
| Un invariante la cui violazione **non dà errore subito** | la lista "Regole che valgono sempre" nel `CLAUDE.md` di radice — una voce breve, col rimando |

Conta come "modifica rilevante" (elenco non esaustivo): endpoint aggiunti, rimossi o
rinominati; cambiamenti allo schema o alle migrazioni; una convenzione di dominio
(denaro, date, segni, FX, split); nuove dipendenze o cambi di stack; modifiche ai
confini fra moduli; variabili d'ambiente attese; build, `Dockerfile` o workflow CI;
cambiamenti al chart.

Le regole di igiene, che sono la parte che si dimentica:

1. **I `CLAUDE.md` non ripetono il `README.md` né `docs/decisions.md`**: rimandano. Due
   copie della stessa verità divergono, e quella sbagliata è la copia.
2. **Correggi le sezioni interessate, non aggiungere note in fondo.** Se una modifica
   rende obsoleta una parte, riscrivila o rimuovila: due paragrafi che si contraddicono
   sono peggio di uno mancante.
3. **Se una cartella nuova ha una sua logica, dalle il suo `CLAUDE.md`** e aggiungi una
   riga alla tabella nella radice. È così che la documentazione cresce di lato invece
   che in su.
4. **Tieni il `CLAUDE.md` di radice sotto le ~130 righe.** Viene caricato all'inizio di
   ogni sessione: se una modifica lo fa crescere oltre, quasi sempre il contenuto
   appartiene a un file più vicino al codice.

Non usare la sintassi `@percorso/file.md` per rimandare a un documento: gli import in
`CLAUDE.md` vengono espansi all'avvio, quindi caricano il file **sempre** e
annullerebbero il senso della divisione. Cita il percorso in prosa normale. L'unica
eccezione è questo file, che contiene regole sempre valide ed è per questo importato
dalla radice.

Non serve aggiornare la documentazione per modifiche puramente cosmetiche (typo,
formattazione, ritocchi di stile) che non cambiano struttura, comportamento o contratto.
