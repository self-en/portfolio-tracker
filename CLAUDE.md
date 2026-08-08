# CLAUDE.md — portfolio-tracker

Guida per Claude quando lavora su questo repository. Gestione del portafoglio
personale di investimenti (azioni, ETF, obbligazioni; base EUR), su questa
piattaforma: ogni branch diventa un ambiente live e `main` è la produzione.

> **Regola di manutenzione**: la documentazione si aggiorna insieme al codice, e ogni
> cartella ha la propria. Dove va cosa: @.claude/instructions.md.

## Le due fonti che esistono già — non duplicarle

Questo progetto era documentato **prima** che ci fosse un `CLAUDE.md`, e bene:

- **`README.md`** — cosa fa l'app, gli endpoint, la cadenza di refresh, la
  configurazione, l'export/import, cosa NON fa. È scritto per una persona ed è la
  fonte da leggere per capire il dominio.
- **`docs/decisions.md`** — le convenzioni bloccate, numerate e motivate (denaro,
  direzione FX, split, date, confini dei moduli, piattaforma, analisi con Claude).
  È la ragione per cui le regole qui sotto sono regole.

I file `CLAUDE.md` **non ripetono** quel contenuto: portano solo ciò che serve nel
momento in cui si modifica una cartella, e rimandano. Due copie della stessa verità
divergono, e la copia sbagliata è quella che verrà letta.

## Dove sta la documentazione

Questo file resta breve di proposito: viene caricato all'inizio di ogni sessione. Il
dettaglio sta accanto al codice e si carica solo quando lavori lì.

| Se lavori su | Leggi |
|---|---|
| backend: confini dei moduli, boot, config, logger, db, market, ai, http | `src/CLAUDE.md` |
| la matematica finanziaria (denaro, FX, split, ratei, rischio) | `src/domain/CLAUDE.md` |
| la SPA React | `web/CLAUDE.md` |
| i test, e i confini che fanno rispettare | `test/CLAUDE.md` |
| il chart Helm con cui la piattaforma distribuisce l'app | `chart/CLAUDE.md` |
| il perché di una convenzione | `docs/decisions.md` |

## Regole che valgono sempre

Sono quelle la cui violazione **non dà errore subito**: i tipi passano, l'app parte,
e un numero è sbagliato o un segnale sparisce in silenzio. Il dettaglio, e il perché,
stanno nei file indicati.

1. **Il denaro è `decimal.js` + `NUMERIC` + stringhe sul filo.** Mai `parseFloat`,
   `Number()` o `.toFixed()` su un float in `domain/` o `repo/`. I type parser di
   `pg` per `NUMERIC`, `INT8` e **`DATE`** sono registrati in `src/db/pool.ts`: senza
   l'override su `DATE`, `2026-01-01` diventa un `Date` a mezzanotte locale e un
   `toISOString()` a valle produce `2025-12-31`.
   → `src/domain/CLAUDE.md`, `docs/decisions.md` §1
2. **La direzione FX è dichiarata una volta**: `rate` = unità di `quote_ccy` per 1
   EUR, quindi per convertire X → EUR si **divide**. Invertire quella riga è il bug
   FX classico e nessun tipo lo cattura. → `src/domain/CLAUDE.md`, §2
3. **Il `close` di Yahoo è già retro-aggiustato per gli split**, quindi la
   valorizzazione usa una serie di quantità *aggiustata* e `adj_close` non si usa mai
   per valorizzare. Senza questo lo split si conta due volte.
   → `src/domain/CLAUDE.md`, §4
4. **Vietato `console.log`**: non viene inoltrato via OTLP, quindi un log così non
   esiste in Grafana. Sempre il `logger` pino. `./scripts/check-no-console.sh` lo
   verifica. → `src/CLAUDE.md`
5. **I confini fra moduli sono fatti rispettare da cinque test**, non sono linee
   guida: `domain/` importa solo `decimal.js`, `market/` non tocca mai `domain/`,
   l'SQL sta solo in `repo/`. → `src/CLAUDE.md`, `test/CLAUDE.md`
6. **Non convertire il backend a ESM.** Su `main` la piattaforma preloada
   `build/instrumentation.js`, che strumenta con monkey-patching di `require()`: con
   output ESM trace, metriche e log spariscono senza un errore. → `src/CLAUDE.md`
7. **Configurazione mancante = locked mode, non crashloop**: `/healthz` resta 200,
   `/api/*` risponde `503 not_configured`. Su questa piattaforma un crashloop non
   lascia log leggibili nella UI. → `src/CLAUDE.md`
8. **`COOKIE_SECURE` resta `false`** finché gli env sono serviti su `http://`. Un
   cookie `Secure` viene scartato in silenzio dal browser: login `204`, poi ogni
   richiesta `401`, e nei log non compare niente. → `chart/CLAUDE.md`
9. **Nessun segreto nel repository**, né in `chart/values.yaml` né come `env:` nel
   Deployment (un `env:` esplicito **vince** su `envFrom` e zittirebbe la UI). Si
   impostano dalla pagina **Configurazione** di nedo. → `chart/CLAUDE.md`
10. **Non modificare `src/platform/config.ts`**: è gestito dalla piattaforma
    (marcato `self-en-contract: <n>`) e viene riscritto. Le modifiche si perdono.
11. **Cancellare un branch distrugge il suo database.** I dati reali vivono sull'env
    di `main`; prima di operazioni distruttive, `GET /api/export`. → README

## Comandi

```bash
npm install --include=dev          # NB: --include=dev, altrimenti pg-mem e vite
npm --prefix web install --include=dev   # vengono saltati in silenzio se NODE_ENV=production

npm test                           # tutta la suite, nessun database richiesto
npm run test:domain                # solo la matematica finanziaria, loop veloce
npm run typecheck                  # gate della CI
npm run check:contract             # gate della CI
./scripts/check-no-console.sh      # gate della CI
npm run build                      # tsc -> build/ + copia dei .sql delle migrazioni
npm run build:web
```

Sviluppo in due terminali, e come lavorare senza Postgres (`npm run dev:memdb`,
`pg-mem`): sono nel README, con le insidie relative.

## Come arriva in produzione

Push del branch → GitHub Actions costruisce l'immagine e la pubblica con il tag
immutabile `sha-<short>` → ArgoCD deploya il chart e dà al branch un env e un proprio
database. Niente passo di deploy manuale, e non va aggiunto. **Le migrazioni non sono
della piattaforma**: le applica l'app al boot, idempotenti, sotto advisory lock
(`src/db/migrate.ts`).
