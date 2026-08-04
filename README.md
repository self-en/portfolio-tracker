# portfolio-tracker

Gestione del portafoglio personale di investimenti: **dashboard degli andamenti**,
**lista movimenti**, **calendario cedole e dividendi** e **prelievo online dei dati
di mercato**. Azioni, ETF e obbligazioni, valuta base EUR con conversione FX.

Inserimento dati **manuale** (nessun import CSV, nessun parser di estratti conto) e
un solo utente, protetto da password.

## Indice

- [Avvio rapido](#avvio-rapido)
- [Come funzionano gli env](#come-funzionano-gli-env)
- [Configurazione obbligatoria](#configurazione-obbligatoria)
- [Architettura](#architettura)
- [Convenzioni che non si negoziano](#convenzioni-che-non-si-negoziano)
- [Test](#test)
- [API](#api)
- [Backup: l'export non è opzionale](#backup-lexport-non-è-opzionale)
- [Osservabilità](#osservabilità)
- [Cosa NON fa (v1)](#cosa-non-fa-v1)

## Avvio rapido

Servono node ≥ 24 e npm. Non serve docker.

```bash
npm install --include=dev          # NB: --include=dev, vedi nota sotto
npm --prefix web install --include=dev

npm test                           # tutta la suite, nessun database richiesto
```

> **Nota su `--include=dev`**: in alcuni ambienti `NODE_ENV=production` è impostata
> nell'ambiente, e in quel caso npm **salta silenziosamente** le devDependencies —
> `pg-mem` e `vite` non vengono installati e i test/build falliscono con un
> `MODULE_NOT_FOUND` che non spiega la causa. `--include=dev` lo rende esplicito.

### Sviluppo: due terminali

```bash
# terminale 1 — API su :3000 (scheduler disattivato)
APP_PASSWORD=dev SESSION_SECRET=$(openssl rand -hex 32) npm run dev:api

# terminale 2 — SPA su :5173, con proxy verso :3000
npm run dev:web
```

Si naviga su **http://localhost:5173**. Il proxy di Vite inoltra `/api` e `/healthz`
al server, così tutto è same-origin e il cookie di sessione funziona senza attriti.

### Sviluppo senza Postgres

In locale non c'è un Postgres (né `psql`, né docker). Per esercitare l'intero stack
HTTP contro un database **in memoria**:

```bash
node scripts/dev-server-memdb.cjs 3099     # password: dev
curl -s -c /tmp/j -H 'content-type: application/json' \
  -d '{"password":"dev"}' localhost:3099/api/auth/login
curl -s -b /tmp/j localhost:3099/api/portfolio/summary | jq
```

`pg-mem` parla Postgres ma **non è** Postgres: i suoi `NUMERIC` sono float-backed e
non passa dai type parser di `pg`. Serve a intercettare errori SQL e a provare i
flussi, non a validare la precisione numerica — quella è verificata dai test di
dominio e sull'env di branch.

## Come funzionano gli env

- Push di un branch → GitHub Actions costruisce l'immagine e la pubblica su GHCR con
  il tag immutabile `sha-<short>`.
- L'`ApplicationSet` di ArgoCD nota il branch e deploya il chart in `chart/`, dando
  al branch un env su `http://<branch>-<hash>.self-en.uk/` **e un proprio database
  Postgres**, creato da un hook PreSync (`CREATE DATABASE`).
- Cancellando il branch, env e database vengono rimossi. → [leggi questo](#backup-lexport-non-è-opzionale)

**Non esiste un meccanismo di migrazione della piattaforma**: l'app crea e migra le
tabelle **al boot**, in modo idempotente, sotto advisory lock (`src/db/migrate.js`).

## Configurazione obbligatoria

L'app richiede due variabili. Senza, **non crasha**: entra in *locked mode* —
`/healthz` resta 200, ogni `/api/*` risponde `503 not_configured` e la SPA mostra una
schermata di configurazione. Su questa piattaforma un crashloop significa nessun log
leggibile nella UI, quindi degradare in modo diagnosticabile è preferibile.

| Variabile        | Obbligatoria | Default | Note                                                      |
| ---------------- | :----------: | ------- | --------------------------------------------------------- |
| `APP_PASSWORD`   |      sì      | —       | password unica di accesso                                  |
| `SESSION_SECRET` |      sì      | —       | ≥32 caratteri. **Non viene auto-generata**: lo farebbe invalidare ogni sessione a ogni deploy, nascondendo la misconfigurazione |
| `COOKIE_SECURE`  |      no      | `false` | **lasciare false** finché la piattaforma serve `http://` — vedi sotto |
| `SCHEDULER_ENABLED` |   no      | `true`  | `false` in sviluppo locale                                 |
| `LOG_LEVEL`      |      no      | `info`  |                                                            |
| `MARKET_PROVIDER`|      no      | `yahoo` | `manual` disattiva ogni chiamata di rete                   |
| `BACKFILL_YEARS` |      no      | `2`     | ampiezza dello storico quando non ci sono transazioni      |

### Impostare i segreti (dalla pagina Configurazione)

`APP_PASSWORD` e `SESSION_SECRET` si impostano dal pannello **nedo**: apri il
progetto → **Configurazione**, compila i due campi (c'è un pulsante "genera") e
salva. La piattaforma li consegna al pod come Secret Kubernetes (`envFrom`), non
passano da questo repository, e la versione riparte da sola.

Le due variabili sono dichiarate in [`self-en.json`](self-en.json), che è ciò che
fa comparire etichetta, descrizione e pulsante "genera" nel form: se in futuro
l'app avrà bisogno di un'altra variabile, va aggiunta lì nello stesso commit.
Ogni variabile può valere per tutte le versioni o solo per la produzione.

Finché i valori non sono impostati l'app resta in **locked mode** (503
`not_configured` su `/api/*`, `/healthz` 200), non in crashloop: un crashloop su
questa piattaforma non lascia log leggibili nella UI.

Non aggiungere quei valori a `chart/values.yaml` (finirebbero in git) e non
dichiararli come `env:` nel Deployment: un `env:` esplicito **vince** su
`envFrom`, quindi zittirebbe in silenzio quello che imposti dalla UI. È
esattamente il wiring che questo repo aveva prima (un Secret `<release>-auth`
creato a mano) e che è stato rimosso.

> ### ⚠️ La trappola del cookie `Secure`
> Gli env di branch sono serviti su **`http://` semplice** (`httproute.yaml` non ha
> configurazione TLS). Un cookie `Secure` viene **scartato in silenzio** dal browser
> su HTTP: il login restituisce `204`, poi ogni richiesta successiva è `401`, e nei
> log non compare nulla. Per questo `COOKIE_SECURE` è `false` per default. Passa a
> `true` il giorno in cui la piattaforma aggiunge TLS.

## Architettura

La root è **CommonJS**; `web/` è un pacchetto **ESM separato** con il suo
`package.json`. Nessun workspace: quel confine è ciò che tiene `type: module` fuori
dal server.

```
server.js                bootstrap sottile: listen() PRIMA delle migrazioni
src/
  config.js              parsing env, rilevamento locked-mode
  logger.js              singleton pino — l'UNICO logger del processo
  app.js                 buildApp() → express app
  boot.js                migrazioni con retry, scheduler, reconciler
  static.js              serve web/dist + fallback SPA
  db/                    pool (type parser!), migrate, leader, migrations/
  repo/                  l'UNICO posto con SQL. Numerici come stringa.
  domain/                PURO. Zero I/O. La superficie di unit test.
  market/                provider, tolerant, refresher, scheduler
  http/                  auth, validate, errors, serialize, routes/
web/                     SPA Vite + React
test/                    domain/ market/ repo/ http/ db/ + fixtures/
docs/decisions.md        le convenzioni bloccate — leggilo prima di contribuire
```

### Confini fatti rispettare da test automatici

Non sono linee guida: tre test falliscono se vengono violati.

| Modulo        | Può importare                 | Non può                                            |
| ------------- | ----------------------------- | -------------------------------------------------- |
| `src/domain/` | **solo `decimal.js`**         | `pg`, `logger`, `Date.now()` — il tempo è parametro |
| `src/repo/`   | `pg`, `domain/`               | provider di mercato, express                       |
| `src/market/` | provider, `repo/`, `logger`   | **mai `domain/`**                                  |
| `src/http/`   | `repo/`, `domain/`, `market/` | SQL inline                                         |

`domain/` è puro e senza I/O: è ciò che rende la matematica finanziaria — il 70% del
rischio — verificabile in locale, dove un database non c'è.

## Convenzioni che non si negoziano

Tutte motivate in **`docs/decisions.md`**. Le tre che mordono più spesso:

1. **Il denaro è `decimal.js` + `NUMERIC` + stringhe sul filo.** Mai `parseFloat`,
   mai `Number()`, mai `.toFixed()` su un float dentro `domain/` o `repo/`. I type
   parser di `pg` per `NUMERIC`, `INT8` e **`DATE`** sono registrati in
   `src/db/pool.js`: senza l'override su `DATE`, `2026-01-01` diventa un `Date` a
   mezzanotte locale e un `toISOString()` a valle produce `2025-12-31`.
2. **Direzione FX dichiarata una volta**: `rate` = unità di `quote_ccy` per 1 EUR.
   Per convertire X → EUR si **divide**. Invertire questa riga è il bug FX classico.
3. **Il `close` di Yahoo è già retro-aggiustato per gli split.** La valorizzazione
   usa una serie di quantità *aggiustata*, e `adj_close` viene salvato ma **mai**
   usato per valorizzare. Senza questo si conta lo split due volte. Verificato: il
   close di AAPL del 2020-06-01 è 80,46 contro ~322 realmente scambiati.

E la regola della piattaforma: **vietato `console.log`** (non viene inoltrato via
OTLP). Sempre il `logger` pino. `./scripts/check-no-console.sh` lo verifica — e nota
che il logger *di default* di `yahoo-finance2` è `console.*`: è l'adapter pino in
`src/market/yahooProvider.js` a prevenire una violazione che il grep non vedrebbe.

## Test

```bash
npm test                    # tutta la suite
npm run test:domain         # solo la matematica finanziaria, loop veloce
npm run test:coverage
LIVE=1 node --test "test/market/live.test.js"   # opt-in: Yahoo e Frankfurter reali
./scripts/check-no-console.sh
npm run build:web
```

Nessun test richiede un database: i test di repository e degli endpoint girano su
`pg-mem`, quelli di dominio non hanno I/O affatto. I test `live` sono esclusi per
default perché dipendono dalla rete e dal rate limit di un IP condiviso.

### Cosa si può verificare SOLO sull'env deployato

1. Migrazioni al boot contro Postgres 16 reale (DDL, indici unique parziali, scale
   `NUMERIC`, advisory lock session-scoped) e la corsa contro il job PreSync.
2. I type parser di `pg` contro un server reale.
3. Comportamento di Yahoo dall'interno del cluster: egress, handshake cookie/crumb,
   se l'IP condiviso si guadagna dei 429.
4. Il percorso di login su HTTP semplice (la trappola `Secure`).
5. La build multi-arch (arm64 sotto QEMU).
6. **Fuso orario**: il container non ha `TZ`, quindi node gira in UTC mentre i cron
   dicono `Europe/Rome`. Lo scheduler logga il fuso risolto al boot per *dimostrare*
   che full-ICU funziona; se comparisse UTC, il rimedio è `apk add --no-cache tzdata`.
7. OTel su `main`: trace, metriche e log in Grafana.

## API

Prefisso `/api`. Denaro e quantità **sempre stringhe**, date sempre `YYYY-MM-DD`.
Errori: `{ error: { code, message, details? } }` con codici
`unauthorized | not_found | validation_error | conflict | db_unavailable | not_configured | upstream_error | rate_limited`.

| Gruppo       | Endpoint                                                                                      |
| ------------ | --------------------------------------------------------------------------------------------- |
| auth         | `POST /auth/login` · `POST /auth/logout` · `GET /auth/me`                                     |
| system       | `GET /healthz` (non autenticato) · `GET /api/system/status`                                    |
| strumenti    | `GET POST /instruments` · `GET PATCH DELETE /instruments/:id` · `GET PUT /instruments/:id/prices` · `POST /instruments/:id/refresh` |
| movimenti    | `GET POST /transactions` · `GET PATCH DELETE /transactions/:id` · **`POST /transactions/preview`** |
| portafoglio  | `/portfolio/summary` · `/positions` · `/value-series` · `/allocation` · `/returns` · `/income` |
| calendario   | `GET /calendar` · **`POST /calendar/:id/confirm`** · `DELETE /calendar/:id`                    |
| mercato      | `GET /market/search` · `POST /market/refresh` · `GET /market/fx` · `GET /market/status`        |
| backup       | `GET /export` · `POST /import`                                                                |

Due endpoint meritano attenzione:

- **`POST /transactions/preview`** non scrive nulla e restituisce importi derivati,
  rateo calcolato e **posizione risultante** con i relativi `warnings` — così un
  oversell si vede *prima* di confermare, e il calcolo del rateo vive lato server
  invece di essere duplicato in React.
- **`POST /calendar/:id/confirm`** crea la transazione di cedola/dividendo
  precompilata dall'evento. In un'app a inserimento manuale questo trasforma il
  calendario nel canale primario di data entry.

### Cadenza di refresh

Gli handler HTTP **non chiamano mai** un provider in modo sincrono; due sole
eccezioni, entrambe azioni utente: `GET /market/search` (con LRU e debounce) e
`POST /market/refresh` (rate-limit 1/min).

| Job              | Cadenza (Europe/Rome)                       |
| ---------------- | ------------------------------------------- |
| quotazioni       | ogni 15 min 09:00–22:30 lun–ven, oraria altrimenti |
| chiusure         | 23:15 giornaliero                            |
| cambi            | 16:30 giornaliero + catch-up al boot         |
| dividendi futuri | 06:00 giornaliero                            |
| backfill storico | one-shot alla creazione dello strumento      |

Lo scheduler è in-process con **leader election via `pg_try_advisory_lock`**: corretto
anche con `replicaCount > 1`. Un reconciler al boot riaccoda i backfill perduti — è
questo che rende accettabile una coda in memoria.

### Le obbligazioni non hanno dati di mercato

Verificato in Fase 0: `IT0005611741`, `IT0005433195`, `IT0005240830` restituiscono
tutti `quotes: []` da Yahoo, e cercare `"BTP"` restituisce banche indonesiane. Quindi
per i bond il **pricing manuale è la strada normale**, non un ripiego:
`price_source='manual'` + `PUT /instruments/:id/prices`. Le cedole future esistono
perché le **calcoliamo** dallo scadenzario (`src/domain/bonds.js`, generato
all'indietro dalla scadenza): è questo che fa funzionare il calendario con copertura
provider pari a zero.

## Backup: l'export non è opzionale

**Cancellare il branch distrugge il suo database.** I dati reali vivono sull'env di
`main`; i branch sono usa e getta.

```bash
curl -b cookie.jar 'http://<host>/api/export' > backup.json
curl -b cookie.jar -X POST -H 'content-type: application/json' \
  --data-binary @backup.json 'http://<host>/api/import'
```

L'import è **additivo** per default; `{"replace": true}` sostituisce tutto. Gli
strumenti sono riconciliati per ISIN/ticker (non per id, che non sopravvivono), i
**prezzi manuali sono sempre inclusi** perché nessun provider può rigenerarli, e le
cedole proiettate vengono **rigenerate** invece di essere importate.

## Osservabilità

Sul solo branch `main` la piattaforma abilita OpenTelemetry: **trace**, **metriche** e
**log** via OTLP verso il collector (Alloy → Tempo / Prometheus / Loki), visibili in
Grafana. I log passano da `pino`, quindi ogni record porta `trace_id`/`span_id`.

Senza Grafana, `GET /api/system/status` riporta readiness, migrazioni applicate e
pendenti, leadership dello scheduler, ultimo esito di ogni job di refresh, fuso orario
risolto e `warnings[]`.

## Cosa NON fa (v1)

Detto esplicitamente, così lo scope non striscia: import CSV/PDF · crypto e conti
deposito (il modello è estensibile, il saldo cassa è derivato) · multiutente ·
FIFO/LIFO (il seam c'è, la strategia no) · **reportistica fiscale italiana** (Quadro
RW/RT, riporto minus, bollo — ampia, soggetta a errori, e un numero sbagliato è
peggio di nessun numero) · benchmark · ribilanciamento · YTM, duration, convexity
(solo rendimento corrente) · grafici intraday, alert, notifiche · opzioni e futures ·
corporate action oltre split e dividendi cash · storico di audit · i18n (italiano
hardcoded) · PWA/offline.

**Non è consulenza fiscale.** Plusvalenze realizzate, redditi e plusvalenze latenti
sono tenute come tre voci separate e mai sommate in un unico "profitto", perché il
trattamento fiscale italiano differisce per involucro. Riconcilia sempre con
l'estratto conto del broker.
