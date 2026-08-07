# Decisioni bloccate

Convenzioni non negoziabili di questo repo. Cambiarne una è un breaking change
che richiede una migrazione e un giro di test, non una modifica locale.

## 1. Denaro: `decimal.js`, `NUMERIC`, stringhe sul filo

- Aritmetica solo con il `Decimal` configurato in `src/domain/money.ts`
  (`precision: 34`, `ROUND_HALF_EVEN`). Mai interi in unità minori: le quantità
  vogliono 8 decimali (quote frazionarie), i tassi FX 10, i prezzi obbligazionari
  sono percentuali con 4+ decimali, e il multivaluta implica esponenti minori
  diversi.
- `ROUND_HALF_EVEN` (arrotondamento del banchiere) sul denaro: HALF_UP introduce
  un bias verso l'alto su migliaia di arrotondamenti.
- **Arrotondare solo ai confini di persistenza e di API.** Mai i valori intermedi.
- Vietati `+`, `*`, `parseFloat`, `Number()`, `.toFixed()` su Number dentro
  `src/domain/` e `src/repo/`.
- Le risposte API portano denaro e quantità come **stringhe**. React formatta con
  `Intl.NumberFormat("it-IT")` in `web/src/format.js` (il frontend è ancora JavaScript).
- L'unico confine float autorizzato è `web/src/charts/`, dove i valori diventano
  coordinate in pixel.

### Type parser di `pg` — obbligatori

In `src/db/pool.ts`, prima di qualsiasi query:

| OID  | Tipo    | Override         | Perché                                                        |
| ---- | ------- | ---------------- | ------------------------------------------------------------- |
| 1700 | NUMERIC | → stringa        | il default è `parseFloat`, che distrugge la precisione        |
| 20   | INT8    | → stringa        | `bigint` non entra in un Number in sicurezza                  |
| 1082 | DATE    | → `'YYYY-MM-DD'` | il default costruisce un `Date` a **mezzanotte locale**       |

L'override su `DATE` è quello che tutti dimenticano: senza, `2026-01-01` diventa
un `Date` locale e un `toISOString()` a valle produce `2025-12-31`.

## 2. Direzione FX — dichiarata una volta

`fx_rates_daily.rate` = **unità di `quote_ccy` per 1 `base_ccy`**, e `base_ccy` è
sempre `'EUR'`.

- Convertire `X` → EUR: `importo / rate`.
- Convertire EUR → `X`: `importo * rate`.
- `transactions.fx_rate` segue la stessa convenzione (EUR → `trade_ccy`).
- `EUR/EUR` = 1 e non viene mai persistito.

Frankfurter v2 (`GET /v2/rates?from=&to=&base=EUR&quotes=USD,GBP`) restituisce un
**array piatto** `[{date, base, quote, rate}]` — verificato in Fase 0, fixture in
`test/fixtures/fx/`. La forma a mappa `{rates:{…}}` è la v1: non usarla.
La v2 pubblica tassi anche nei weekend e nei festivi; il forward-fill resta
difensivo, non è il caso quotidiano.

## 3. Costo di carico: medio ponderato

Default **costo medio ponderato** per strumento, la convenzione degli
intermediari italiani in regime amministrato: i numeri riconciliano con
l'estratto conto del broker, che è la sola riconciliazione che conti.

- Implementato come reducer in `src/domain/positions.ts`:
  `buildPositions(txs, { method: "AVERAGE" })`. Il parametro `method` è il seam
  per FIFO (v1.1) — non ancora implementato.
- **Le commissioni di acquisto aumentano il carico** (prassi italiana).
- **Il rateo cedolare pagato all'acquisto è escluso dal carico**: è una voce di
  reddito negativa, recuperata alla cedola successiva, tracciata in
  `accruedPaid`.
- `RETURN_OF_CAPITAL` riduce il carico; l'eccedenza sotto zero finisce nel
  realizzato.
- `FEE` / `TAX` standalone non sono capitalizzate.

**Plusvalenza realizzata, redditi e plusvalenza latente restano tre voci
separate in ogni risposta.** Non vengono mai sommate in un unico "profitto": il
trattamento fiscale italiano differisce per involucro (le plusvalenze da ETF sono
redditi di capitale e non compensano le minus da redditi diversi; il rateo
cedolare è reddito, non capital gain). L'app dichiara in UI che non è consulenza
fiscale.

## 4. Aggiustamento per gli split

La serie `close` del `chart` di Yahoo è **retroattivamente aggiustata per gli
split** ma non per i dividendi. Verificato in Fase 0: la fixture
`test/fixtures/yahoo/chart-AAPL-splitdiv.json` riporta `close: 80.46` per il
2020-06-01, quando il prezzo effettivamente scambiato era ~322 USD (split 4:1 del
2020-08-31).

Quindi, se si moltiplicassero anche le quantità storiche per le transazioni
`SPLIT`, la valorizzazione storica **conterebbe due volte lo split**.

Regole:

1. La valorizzazione usa `prices_daily.close` (serie già aggiustata da Yahoo)
   contro una **serie di quantità aggiustata per gli split** —
   `splitAdjustedQuantitySeries()` riporta le quantità storiche in termini di
   quote odierne: `qtyAdj(d) = qty(d) * Π(ratio di ogni SPLIT con trade_date > d)`.
2. **Il ledger non viene mai mutato.**
3. `adj_close` viene salvato ma **mai** usato per valorizzare: retro-aggiusta per
   i dividendi, che già registriamo come transazioni.
4. Quando un refresh scopre uno split *nuovo*, si ri-scarica l'intero storico
   dello strumento perché la serie `close` in cache resti internamente coerente.

## 5. Prezzi mancanti: forward-fill, mai zero

- **Solo forward-fill** (ultima osservazione riportata avanti). Mai interpolare,
  mai back-fill.
- Prezzo mancante *prima* della prima osservazione → `partial: true` sul punto,
  voce in `warnings[]`, contributo 0 dello strumento. **Uno zero silenzioso
  sembra un crollo del portafoglio, non un buco nei dati**: è la peggior modalità
  di fallimento dell'intera app. La UI rende tratteggiati i segmenti parziali.

## 6. Date

Tutta la matematica sulle date lavora su stringhe `"YYYY-MM-DD"` con aritmetica
`Date.UTC`, **mai su un `Date` in fuso locale**. Così il DST si aggira invece di
testarci intorno. Vedi `src/domain/calendar.ts`.

`transactions.trade_date` è la data economica (ex-date per i redditi) e guida
tutta la matematica. `settle_date` è informativa.

## 7. Confini dei moduli

| Modulo         | Può importare                       | Non può                                             |
| -------------- | ----------------------------------- | --------------------------------------------------- |
| `src/domain/`  | **solo `decimal.js`**               | `pg`, `logger`, `Date.now()` — il tempo è parametro  |
| `src/repo/`    | `pg`, `domain/`                     | provider di mercato, fastify                        |
| `src/market/`  | provider, `repo/`, `logger`         | **mai `domain/`**                                   |
| `src/ai/`      | `config`, `logger`, Claude Agent SDK | `pg`, `db/`, `repo/`, fastify — vedi §12           |
| `src/http/`    | `repo/`, `domain/`, `market/`, `ai/` | SQL inline                                         |

`domain/` è puro e senza I/O: è la superficie di unit test, ed è ciò che rende la
matematica verificabile senza Postgres (che in locale non c'è).

## 8. Quantità e segni

- `transactions.quantity` è **sempre positiva**; la direzione vive in `type`.
- `net_amount` è l'effetto cassa **con segno**, in `trade_ccy`
  (negativo per BUY/FEE/TAX/WITHDRAWAL).
- `gross_amount` è l'importo **lordo**: per i dividendi, prima della ritenuta.
  La ritenuta sta in `taxes`. Da qui `incomeNet = incomeGross - taxWithheld`.
- Oversell (SELL > quantità in carico) → si clampa a `qty`, si aggiunge un
  warning `{code:"oversell"}` e si continua. **Mai quantità negative silenziose.**

## 9. Obbligazioni

- Copertura Yahoo **zero** — verificato in Fase 0: `IT0005611741`,
  `IT0005433195`, `IT0005240830` restituiscono tutti `quotes: []`. Il pricing
  manuale dei bond non è un fallback, è *la* strada (`price_source='manual'`).
- `quote_convention = 'PCT_OF_NOMINAL'`: `nominale = quantity × face_value`,
  `valore = nominale × price/100 × fx`.
- `coupon_rate` è una **frazione annua** (`0.0345` = 3,45%), non una percentuale.
- `income_events.amount_per_unit` per le cedole è **per 100 di nominale**; per i
  dividendi è per azione.
- Lo scadenzario cedolare si genera **all'indietro dalla scadenza**, così il
  periodo irregolare cade all'inizio, dove deve stare. Convenzione fine mese
  preservata (`addMonthsPreserveEom`).
- Default day count **ACT/ACT-ICMA** (convenzione BTP).
- La serie usa il corso **secco**; il rateo è riportato a parte, con flag
  `includeAccrued` per commutare il totale.
- Le cedole future sono `income_events` con `status='PROJECTED'`,
  `source='schedule'`, rigenerate a ogni modifica dei campi bond. **È questo che
  fa funzionare il calendario con copertura provider pari a zero.**

## 10. Piattaforma

- **Vietato `console.log`**: non viene inoltrato via OTLP. Sempre il `logger`
  pino di `src/logger.ts`. Nota: il logger di default di `yahoo-finance2` è
  `console.*` → l'adapter in `src/market/yahooProvider.ts` è ciò che previene una
  violazione silenziosa. Deve fornire tutti e cinque
  `info/warn/error/debug/dir`.
- **Mai crashare al boot.** Un crashloop su questa piattaforma significa nessun
  log nella UI e nessun modo di diagnosticare. `listen()` viene prima delle
  migrazioni; DB non pronto o config mancante → `/healthz` resta 200 e `/api/*`
  risponde 503 con un codice diagnostico.
- **Nessun meccanismo di migrazione della piattaforma**: le tabelle si creano al
  boot, in modo idempotente, sotto advisory lock.
- `yahoo-finance2` è **pinnato esatto a `4.0.0`**: è la dipendenza soggetta a
  drift. Il `versionCheck` di default fa una chiamata di rete al boot →
  disattivato.
- Cookie di sessione **senza `Secure` per default**: gli env di branch sono
  serviti su `http://` semplice e un cookie `Secure` viene scartato in silenzio
  dal browser, producendo login 204 seguito da 401 su tutto, senza nulla nei log.
  `COOKIE_SECURE=true` il giorno in cui la piattaforma aggiunge TLS.
- **Tre direttive che assumono HTTPS vanno tutte disattivate**, non solo la prima.
  Sono la stessa trappola con tre facce, e le ultime due sono ancora più subdole
  del cookie perché rompono la pagina *prima* che l'app riceva una richiesta:

  | Cosa | Dove | Se attiva su HTTP |
  | --- | --- | --- |
  | `Secure` sul cookie | `src/config.ts` | login 204, poi 401 su tutto |
  | `hsts` | `src/app.ts` (helmet) | il browser cerca https per mesi |
  | `upgrade-insecure-requests` | `src/app.ts` (helmet, **default ON**) | pagina bianca: ogni asset richiesto in https |

  `upgradeInsecureRequests: null` è obbligatorio nella CSP: helmet la include per
  default, e ordina al browser di riscrivere in https ogni richiesta della pagina.
  Su un host senza TLS il risultato è una SPA che non carica nulla.
- Il database del branch viene distrutto con il branch → `GET /api/export` e
  `POST /api/import` non sono opzionali: sono l'unica rete di sicurezza per dati
  inseriti a mano.

## 11. Note sulle fixture di Fase 0

Dettagli reali della risposta Yahoo, catturati e non indovinati:

- Le barre di `chart` usano **`adjclose`** (c minuscola), non `adjClose`.
- Quando nel periodo non ci sono eventi, la chiave `events` è **completamente
  assente** dalla risposta — non `{}`, non `[]`. Un accesso diretto a
  `chart.events.dividends` è quindi un TypeError su ogni strumento senza
  dividendi nella finestra richiesta. (Il normalizzatore tollera comunque anche
  `{}` e `[]`: costa una riga.)
- `events.splits[]` porta `{numerator, denominator, splitRatio: "4:1"}` →
  `ratio = numerator / denominator`.
- `quoteSummary` **omette i moduli assenti** (`calendarEvents` non c'è per
  `EUNL.DE`, c'è per `AAPL`): mai assumere che un modulo richiesto sia presente.
- `chart` bar `date` è un istante UTC all'apertura del mercato
  (`2024-01-02T08:00:00Z` per Xetra, `2020-06-01T13:30:00Z` per NYSE) → la parte
  UTC della data è la `price_date` corretta per i mercati europei e americani.
- `require("yahoo-finance2").default` costruisce senza problemi su node 24 e
  accetta l'adapter pino: **nessuna migrazione ESM necessaria**.

## 12. Analisi degli strumenti con Claude

La funzione produce **prosa**, non numeri: il modello non calcola né scrive prezzi,
quantità, valorizzazioni o rendimenti. Tutti i numeri che vede sono già stati
calcolati da `domain/` e serializzati come nel resto dell'API. È il confine che
tiene la matematica finanziaria — il 70% del rischio — fuori dalla portata di un
generatore di testo.

- **Senza `CLAUDE_CODE_OAUTH_TOKEN` la funzione è spenta, non rotta.** Non è un motivo di
  locked mode: il portafoglio funziona benissimo senza analisi. `GET` risponde 200 con
  `configured: false`, `POST` risponde **`ai_unavailable`** (503) — codice distinto da
  `not_configured`, che nella SPA significa "l'app non è configurata" e aprirebbe la
  schermata di configurazione mandando l'utente a impostare `APP_PASSWORD`.
- **Nessuna generazione automatica.** Ogni analisi è una chiamata a pagamento: parte
  solo da un click, con rate limit (`ANALYSIS_RATE_LIMIT`, default 20/ora) che difende
  la bolletta, non dal brute force. Nessuno scheduler la accoda, mai.
- **Un'analisi è una FOTOGRAFIA datata, quindi si persiste e non si sovrascrive.**
  `instrument_analyses` è append-only e conserva lo `context` completo — lo snapshot
  dei dati di ingresso. Rigenerarla domani non la riproduce: dà un'altra analisi. Per
  questo entra nell'export (a differenza di quotazioni e cambi, che si riscaricano) e
  il reimport è idempotente sulla chiave `(instrument_id, created_at)`.
- **Terza eccezione alla regola sui provider.** Gli handler HTTP non chiamano
  provider in modo sincrono; `POST /instruments/:id/analysis` si aggiunge a
  `/market/search` e `/market/refresh` perché i fondamentali servono *adesso* per
  costruire il prompt.
- **Si passa dal Claude Agent SDK, non dall'API Messages.** La credenziale che il
  deployment possiede è `CLAUDE_CODE_OAUTH_TOKEN`, cioè il token di Claude Code.
  Puntato direttamente su `/v1/messages` viene accettato ma consuma i limiti
  dell'abbonamento invece di quelli di una chiave API: il risultato erano **429
  `rate_limit_error` su ogni analisi**, identici su dev e su main. `@anthropic-ai/sdk`
  resta fra le dipendenze perché è una *peer* dell'Agent SDK, non perché lo chiamiamo.
  Il prezzo da pagare è l'eseguibile di Claude Code (~280 MB) nell'immagine: per
  questo il caricamento è `import()` dinamico e lazy, e senza token non si tocca.
- **L'agente è confinato: `tools: []` e `settingSources: []`.** Sono le due righe che
  trasformano un agente di programmazione in un analista di bilanci. Senza la prima
  potrebbe leggere e scrivere il filesystem del container; senza la seconda si
  caricherebbe il `CLAUDE.md` del repository dentro un prompt che deve parlare solo di
  finanza — pagandolo, e sbilanciando l'analisi. `persistSession: false` perché il
  contesto completo è già in database. Verificate da un test su `buildQueryOptions`,
  che è pura apposta.
- **Una chiave API dimenticata nell'ambiente non deve scavalcare il token.**
  `subprocessEnv()` cancella `ANTHROPIC_API_KEY` e `ANTHROPIC_AUTH_TOKEN` prima di
  lanciare il sottoprocesso: altrimenti il CLI le preferirebbe, addebitando le analisi
  su un altro account. È l'erede dell'`apiKey: null` che serviva al client HTTP.
- **Output strutturato + doppia guardia.** Lo schema JSON (`outputFormat`) vincola il
  modello e torna in `structured_output`; zod rivalida in casa; il `CHECK` constraint è
  l'ultima rete. Verdetto e confidenza sono liste chiuse dichiarate in tre posti che
  devono restare allineati: `src/ai/prompt.ts`, `004_instrument_analyses.sql`,
  `web/src/types.ts`.
- **Il prompt di sistema è il prefisso in cache: non contiene dati dello strumento.**
  I dati vivono nel turno utente. Il blocco specifico per classe di attivo si
  **appende** al prefisso comune, così le classi sono cinque prefissi memorizzabili
  invece di uno inutilizzabile. Interpolare il nome di un titolo nel prompt di sistema
  invaliderebbe la cache a ogni analisi, in silenzio e a pagamento.
- **Un dato che manca si dichiara.** `contextGaps()` calcola le lacune *sul contesto*,
  lato server, e la pagina le mostra accanto a quelle autodichiarate dal modello. È la
  stessa regola dei prezzi mancanti (§5): un provider senza fondamentali su un BTP è
  il caso NORMALE, e un'analisi che non dice su cosa non ha potuto lavorare non è
  verificabile. Nello stesso spirito, uno zero del provider dove il dato non esiste
  (`grossProfit: 0` su 416 miliardi di ricavi) viene normalizzato a `null`: un numero
  sbagliato è molto peggio di un numero assente.
- **`src/ai/` è un modulo di confine, come `src/market/`.** Riceve un contesto già
  assemblato e restituisce un risultato validato: non conosce `pg`, `repo/`, `db/` né
  fastify, e solleva errori con un `code` che il layer HTTP traduce. È ciò che rende
  l'intero percorso provabile con un runner finto (`_setClient`), senza spendere un
  euro a ogni `npm test`.
- **`domain/riskMetrics.ts` calcola volatilità, drawdown e distanze dai massimi sui
  NOSTRI prezzi**, non li chiede al provider: così esistono anche dove la copertura è
  zero (i BTP) e sono verificabili con un unit test. La data di riferimento è un
  parametro, come per tutto `domain/`.
- **Non è consulenza finanziaria**, e il disclaimer viaggia nella risposta dell'API —
  non solo nella pagina — così ogni client lo mostra.

### 12.1 Tre trappole trovate in review, e le regole che ne restano

- **√252 vale solo su un passo giornaliero.** `riskMetrics` classifica la serie
  (`granularity: "daily" | "sparse"`, mediana dei divari ≤ 4 giorni) e su una serie
  sparsa NON calcola volatilità, medie mobili e trend. Su un BTP a pricing manuale —
  una rilevazione al mese, che per le obbligazioni è la strada normale (§9) —
  annualizzare rendimenti mensili con √252 sovrastima la volatilità di ~4,6 volte, e
  quel numero finirebbe in un prompt che lo dichiara "annualizzato". Vale la stessa
  regola per le SMA: "50 giorni" su una serie mensile sono quattro anni.
- **I timestamp delle analisi sono troncati al MILLISECONDO** (`DEFAULT
  date_trunc('milliseconds', now())`). `TIMESTAMPTZ` ha precisione al microsecondo, ma
  il driver `pg` consegna un `Date` JS che si ferma al millisecondo: un timestamp con i
  microsecondi non sopravvive al giro export → JSON → import, e la deduplicazione
  dell'import fallirebbe *silenziosamente* duplicando le analisi a ogni reimport.
  `date_trunc` è registrato anche nell'harness pg-mem (`test/helpers/memdb.ts`),
  perché lo schema di produzione non si piega a un builtin mancante nel mock.
- **"L'ultima analisi" si ordina per `created_at`, mai per `id`.** L'import conserva la
  data originale e l'export emette dalla più recente: dopo un reimport la più recente
  ha l'id più BASSO. Un `MAX(id)` faceva mostrare alla lista strumenti un verdetto
  diverso da quello del dettaglio.

### 10.1 Cosa si dichiara in `self-en.json` (e cosa no)

`self-en.json` non è l'elenco delle variabili che il codice legge: è l'elenco dei
campi che il pannello **Configurazione** mostra a una persona. Ci vanno solo:

- i valori **senza i quali l'app non parte** (`APP_PASSWORD`, `SESSION_SECRET`:
  mancandoli si entra in locked mode, e la piattaforma deve poterli chiedere);
- i valori che **costano soldi o quota** (`CLAUDE_CODE_OAUTH_TOKEN`).

Tutto il resto — fuso dei cron, dimensione del pool, provider di mercato, modello e
sforzo dell'analisi — resta leggibile da `process.env` con un default sensato ma
**fuori dal form**: quindici campi che nessuno deve toccare rendono invisibili i due
che contano. È lecito perché `src/config.ts` è il `configModule` dichiarato nel
contratto, e i moduli di configurazione sono esenti dal controllo che pretende la
dichiarazione di ogni `process.env` (`scripts/check-contract.mjs`).

Il controllo continua a fare il suo lavoro dove serve: un `process.env` in un
qualsiasi ALTRO file resta un errore di build.
