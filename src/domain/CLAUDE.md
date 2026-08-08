# Dominio — `src/domain/`

La matematica finanziaria, e **circa il 70% del rischio del progetto**. È puro: zero
I/O, nessun `pg`, nessun `logger`, **nessun `Date.now()`** — il tempo entra come
parametro. È questo che la rende verificabile in locale, dove un database non c'è.

Un errore qui non dà eccezioni: dà un numero plausibile e sbagliato. Per questo ogni
regola sotto è bloccata in `../../docs/decisions.md`, con il paragrafo indicato.

- `money.ts` — l'aritmetica su `decimal.js`.
- `positions.ts` — costo di carico, posizioni (`buildPositions`).
- `valuation.ts` — valorizzazione e serie storiche.
- `returns.ts` — rendimenti. `riskMetrics.ts` — volatilità, drawdown, medie mobili.
- `txAmounts.ts` — importi derivati dalle transazioni, ratei.
- `bonds.ts` — scadenzario cedolare. `calendar.ts` — aritmetica sulle date.
- `types.ts` — i tipi del dominio (distinto da `../types.ts`).

## Le regole che mordono

**1. Il denaro è `decimal.js`, `NUMERIC` in database, stringhe sul filo** (§1). Mai
`parseFloat`, mai `Number()`, mai `.toFixed()` su un float qui dentro. I type parser
di `pg` per `NUMERIC`, `INT8` e **`DATE`** sono registrati in `../db/pool.ts` e sono
obbligatori: senza l'override su `DATE`, `2026-01-01` arriva come `Date` a mezzanotte
locale e un `toISOString()` a valle produce `2025-12-31`.

**2. Direzione FX, dichiarata una volta** (§2): `rate` = unità di `quote_ccy` per 1
EUR. Per convertire X → EUR si **divide**. Invertirla è il bug FX classico, e nessun
tipo lo cattura.

**3. Il `close` di Yahoo è già retro-aggiustato per gli split** (§4). Quindi la
valorizzazione usa quella serie contro una **serie di quantità aggiustata**
(`splitAdjustedQuantitySeries()`), il ledger **non si muta mai**, e `adj_close` si
salva ma non si usa **mai** per valorizzare (retro-aggiusta anche per i dividendi, che
già registriamo come transazioni). Moltiplicare anche le quantità storiche conterebbe
lo split due volte: la fixture di AAPL riporta `close: 80.46` per il 2020-06-01 contro
~322 USD realmente scambiati.

**4. Prezzi mancanti: solo forward-fill, mai zero** (§5). Mai interpolare, mai
back-fill. Un prezzo mancante prima della prima osservazione → `partial: true` sul
punto, voce in `warnings[]`, contributo 0. **Uno zero silenzioso sembra un crollo del
portafoglio, non un buco nei dati**: è la peggior modalità di fallimento dell'app.

**5. Le date sono stringhe `"YYYY-MM-DD"` con aritmetica `Date.UTC`** (§6), mai un
`Date` in fuso locale: così il DST si aggira invece di testarci intorno. `trade_date`
è la data economica e guida tutta la matematica; `settle_date` è informativa.

**6. Le quantità sono sempre positive, la direzione vive in `type`** (§8).
`net_amount` è l'effetto cassa **con segno**; `gross_amount` è il lordo (per i
dividendi, prima della ritenuta, che sta in `taxes`). Un oversell si **clampa** a `qty`
con un warning `{code:"oversell"}` e si continua: **mai quantità negative silenziose**.

**7. Realizzato, redditi e latente sono tre voci separate, mai sommate** (§3). Il
trattamento fiscale italiano differisce per involucro, quindi un unico "profitto"
sarebbe un numero sbagliato con l'aria di essere quello giusto. Le commissioni di
acquisto aumentano il carico; il rateo cedolare pagato all'acquisto ne è escluso
(`accruedPaid`).

**8. Obbligazioni** (§9): `coupon_rate` è una **frazione annua** (`0.0345` = 3,45%),
non una percentuale. `amount_per_unit` è **per 100 di nominale** per le cedole, per
azione per i dividendi. Lo scadenzario si genera **all'indietro dalla scadenza**, così
il periodo irregolare cade all'inizio; day count ACT/ACT-ICMA; corso secco con il rateo
riportato a parte.

## Se stai aggiungendo un calcolo

Il tempo e i prezzi entrano come **parametri**, non li vai a prendere: è ciò che
rende il test un caso tabellare invece di un mock. Se ti serve un import fuori da
`decimal.js`, il posto giusto non è questo (probabilmente è `../repo/` o `../http/`) —
e comunque un test di confine ti fermerà, vedi `../../test/CLAUDE.md`.

Le metriche che richiedono una serie **giornaliera** (volatilità, medie mobili) non
vanno calcolate su una serie sparsa: su un bond a prezzo manuale, con una rilevazione
al mese, `√252` e "SMA 50 giorni" sarebbero etichette false. Al loro posto va una
lacuna dichiarata.
