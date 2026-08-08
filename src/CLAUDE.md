# Backend — `src/`

Backend TypeScript su Fastify, compilato in `build/` da `tsc`. Il perché di ogni
convenzione citata qui è in `../docs/decisions.md`; cosa fa l'app e quali endpoint
espone è nel `../README.md`. Questo file è ciò che serve sapere **mentre** si modifica
questa cartella.

## I moduli, e cosa fa ciascuno

- `server.ts` — bootstrap sottile: chiama `listen()` **prima** delle migrazioni, così
  la readinessProbe risponde mentre il database si prepara.
- `boot.ts` — migrazioni con retry, scheduler, reconciler dei backfill perduti.
- `app.ts` — `buildApp()` → l'istanza Fastify. È qui che si registra un plugin nuovo.
- `config.ts` — parsing dell'ambiente e rilevamento del locked mode. **L'unico posto
  che legge `process.env`** (vedi sotto).
- `logger.ts` — singleton pino: **l'unico logger del processo**.
- `static.ts` — serve `web/dist` + fallback SPA (`notFoundHandler`).
- `types.ts` — il modello di dominio: numerici come **stringa**, date `"YYYY-MM-DD"`.
- `instrumentation.ts` — bootstrap OTel (set automatico + `instrumentation-fastify`).
- `platform/config.ts` — contratto con la piattaforma. **Gestito da nedo, non
  modificare**: è marcato `self-en-contract: <n>` e viene riscritto.
- `db/` — `pool` (i type parser!), `migrate`, `leader`, `migrations/`.
- `repo/` — **l'unico posto con SQL**. Numerici come stringa.
- `domain/` — **puro, zero I/O**. Ha il suo `domain/CLAUDE.md`: leggilo prima di
  toccare un calcolo.
- `market/` — provider, `tolerant`, `refresher`, `scheduler`.
- `ai/` — analisi con Claude: prompt **puri** + client + validazione.
- `http/` — `auth`, `validate`, `errors`, `serialize`, `routes/` (plugin Fastify).

## Confini fatti rispettare da test automatici

Non sono linee guida: **cinque test falliscono** se vengono violati (vedi
`../test/CLAUDE.md`).

| Modulo    | Può importare | Non può |
|---|---|---|
| `domain/` | **solo `decimal.js`** | `pg`, `logger`, `Date.now()` — il tempo è un parametro |
| `repo/`   | `pg`, `domain/` | provider di mercato, fastify |
| `market/` | provider, `repo/`, `logger` | **mai `domain/`** |
| `http/`   | `repo/`, `domain/`, `market/`, `ai/` | SQL inline |
| `ai/`     | `config`, `logger`, SDK Anthropic | `pg`, `repo/`, `db/`, fastify |

`domain/` è puro e senza I/O: è ciò che rende la matematica finanziaria — il 70% del
rischio — verificabile in locale, dove un database non c'è. Aggiungendo un modulo,
decidi in quale riga di questa tabella sta **prima** di scrivere gli import.

## Due moduli di configurazione, non confonderli

- **`config.ts`** è l'unico punto che legge `process.env`, ed è possibile perché è
  dichiarato come `configModule` in `../self-en.json`: in quanto tale è **esente** dal
  controllo di `../scripts/check-contract.mjs` che pretende la dichiarazione di ogni
  variabile. Ogni altro file deve ricevere i valori da qui, non leggerli.
- **`platform/config.ts`** è il contratto con la piattaforma (serve
  `GET /_self-en/config`, valida le variabili dichiarate, mostra la pagina "da
  configurare"). È della piattaforma e viene riscritto: non modificarlo.

**Cosa va dichiarato in `self-en.json` e cosa no**: nel form ci va ciò che una persona
deve decidere — una password, una credenziale che costa. Le manopole con un default
sensato (fuso dei cron, dimensione del pool, modello dell'analisi) restano leggibili
dall'ambiente ma **fuori** dal form, perché quindici campi da non toccare rendono
invisibili i due che contano. Regola pratica: **se l'app non parte senza quel valore,
o se costa soldi, va nel form; altrimenti no.** L'elenco completo, con i default, è nel
README; il perché in `../docs/decisions.md` §10.1.

## Locked mode: degradare, non morire

Senza `APP_PASSWORD` e `SESSION_SECRET` l'app **non crasha**: `/healthz` resta 200,
ogni `/api/*` risponde `503 not_configured`, la SPA mostra la schermata di
configurazione. Su questa piattaforma un crashloop non lascia log leggibili nella UI,
quindi degradare in modo diagnosticabile è preferibile. **Non "sistemare" questo
facendo fallire la readiness**: renderebbe irraggiungibile proprio la pagina che
spiega cosa manca.

`ai_unavailable` è distinto da `not_configured` di proposito: il secondo significa
"l'app non è configurata" e apre quella schermata, il primo "l'app funziona, manca
solo il token per l'analisi".

## Log: solo pino, mai `console`

`console.log` **non viene inoltrato via OTLP**, quindi un log così non esiste in
Grafana. Sempre il `logger` di `logger.ts` (o `request.log`), che porta
`trace_id`/`span_id`. `../scripts/check-no-console.sh` lo verifica — e nota che il
logger *di default* di `yahoo-finance2` è `console.*`: è l'adapter pino in
`market/yahooProvider.ts` a prevenire una violazione che il grep non vedrebbe. Se
aggiungi una libreria che stampa da sé, serve lo stesso trattamento.

## Perché il backend è CommonJS

Su `main` la piattaforma preloada `build/instrumentation.js`, che strumenta facendo
monkey-patching di `require()`. Con output ESM, fastify/pg/pino non verrebbero
patchati e trace, metriche e log spariscono **in silenzio**. `web/` è un pacchetto ESM
separato con il suo `package.json`, senza workspace: quel confine è ciò che tiene
`type: module` fuori dal server. **Non convertire il backend a ESM** senza prima
sistemare la strumentazione.

## Database e migrazioni

L'istanza Postgres è dedicata al progetto e **ogni branch ha il proprio database**,
creato da un hook PreSync del chart. Le migrazioni **non** sono della piattaforma: le
applica l'app al boot, idempotenti, sotto advisory lock (`db/migrate.ts`), con retry —
il database del branch può essere ancora in provisioning quando il pod parte.

I **type parser di `pg`** in `db/pool.ts` (`NUMERIC`, `INT8`, `DATE`) sono
obbligatori, non un'ottimizzazione: vedi la regola sul denaro in
`domain/CLAUDE.md`.

Lo scheduler è in-process con **leader election via `pg_try_advisory_lock`**, quindi
resta corretto anche con `replicaCount > 1`. Un reconciler al boot riaccoda i backfill
perduti: è questo che rende accettabile una coda in memoria.

## Chiamate ai provider

Gli handler HTTP **non chiamano mai** un provider in modo sincrono. Le tre eccezioni
sono azioni utente esplicite (`GET /market/search`, `POST /market/refresh`,
`POST /instruments/:id/analysis`) e sono elencate con i loro rate limit nel README.
Aggiungendo un endpoint che ha bisogno di dati freschi, la strada normale è accodare
un refresh, non chiamare il provider nella richiesta.
