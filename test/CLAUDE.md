# Test — `test/`

I test girano contro i **sorgenti `.ts`** (`node --import tsx --test`), quindi la rete
di sicurezza non dipende dalla build. **Nessun test richiede un database**: quelli di
dominio non hanno I/O, quelli di repository e degli endpoint girano su `pg-mem`.

```bash
npm test                 # tutta la suite
npm run test:domain      # solo la matematica finanziaria, loop veloce
npm run test:coverage
npm run typecheck:test
LIVE=1 node --test "test/market/live.test.js"   # opt-in: Yahoo e Frankfurter reali
```

I test `live` sono esclusi per default perché dipendono dalla rete e dal rate limit di
un IP condiviso: un rosso lì non dice niente sul codice.

`pg-mem` parla Postgres ma **non è** Postgres: i suoi `NUMERIC` sono float-backed e non
passa dai type parser di `pg`. Serve a intercettare errori SQL e a provare i flussi,
non a validare la precisione numerica — quella è verificata dai test di dominio e
sull'env di branch.

## I test di confine, e la lezione che portano

Cinque test fanno rispettare i confini fra moduli (`domain/` importa solo
`decimal.js`, `market/` non tocca `domain/`, l'SQL sta solo in `repo/` — la tabella è
in `../src/CLAUDE.md`). Non sono linee guida: sono rossi se li violi.

`helpers/sourceScan.ts` esiste per una ragione che vale oltre questo repo: quei tre
test si erano **spenti senza fallire**. Filtravano `.endsWith(".js")` e cercavano
`require("...")`, e dopo il passaggio del backend a TypeScript non trovavano più
nessun file: passavano iterando su un insieme vuoto. **Un test che non guarda niente è
peggio di un test che non c'è, perché sembra verde.** Per questo `readSources`
*pretende* di aver trovato qualcosa e fallisce se l'insieme è vuoto.

Due conseguenze da preservare scrivendo test di questo tipo:

- **asserisci che l'input dello scan non sia vuoto**, sempre;
- **togli i commenti prima di analizzare** (`stripComments`): questi file *parlano*
  delle regole che rispettano ("il dominio non chiama mai `Date.now()`"), e cercare nel
  sorgente grezzo darebbe un falso positivo su ogni commento ben scritto.

## Cosa NON si può verificare qui

Sette cose sono verificabili **solo sull'env deployato** — migrazioni contro Postgres
reale e la corsa col job PreSync, i type parser contro un server vero, il
comportamento di Yahoo dall'interno del cluster, il login su HTTP semplice (la trappola
del cookie `Secure`), la build multi-arch, il fuso orario del container, OTel su
`main`. L'elenco con i dettagli è nel `../README.md`: se stai per scrivere un test che
finge una di queste, probabilmente non serve.

## Fixture

`fixtures/` contiene risposte reali di Yahoo e Frankfurter catturate in Fase 0, ed è
ciò che rende i test deterministici. Sono anche **prove**: `chart-AAPL-splitdiv.json`
documenta che il `close` è già aggiustato per gli split (`80.46` per il 2020-06-01
contro ~322 USD scambiati), che è la ragione della regola sulla valorizzazione.
Aggiornandole, non "sistemare" un numero che sembra strano senza aver verificato alla
fonte cosa significa.
