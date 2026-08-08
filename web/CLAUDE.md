# Frontend — `web/`

SPA React (React 19, react-router, TanStack Query, Recharts) costruita da Vite. È un
**pacchetto ESM separato**, con il suo `package.json` e il suo `tsconfig.json`: non c'è
workspace, e quel confine è ciò che tiene `type: module` fuori dal server (che deve
restare CommonJS — vedi `../src/CLAUDE.md`).

Conseguenza pratica: le dipendenze qui si installano a parte,
`npm --prefix web install --include=dev`. Il flag serve perché in un ambiente con
`NODE_ENV=production` npm salta **in silenzio** le devDependencies, e `vite` non viene
installato: l'errore che si vede è un `MODULE_NOT_FOUND` che non spiega la causa.

- `src/main.tsx` — entry. `src/App.tsx` — routing e layout.
- `src/AppContext.tsx`, `src/auth.tsx` — stato condiviso e sessione.
- `src/api.ts` — **l'unica uscita HTTP della SPA**.
- `src/pages/` — una per schermata. `src/components/` — riuso.
- `src/charts/` — i grafici e il loro tema; `src/format.ts` — formattazione.
- `../index.html` sta in `web/`, non nella radice del repo.

## `api.ts` è l'unico punto che parla HTTP

Il server ha **una sola forma d'errore** — `{ error: { code, message, details? } }` — e
la traduzione in `ApiError` avviene solo lì: **nessuna pagina deve ragionare in termini
di status code**. Se ti serve gestire un caso nuovo, aggiungi un `code` e gestisci
quello, non un `res.status === 409` sparso in un componente.

Due codici da non confondere, perché guidano schermate diverse:
`not_configured` = l'**app** non è configurata (apre la schermata di configurazione);
`ai_unavailable` = l'app funziona, manca solo il token per l'analisi con Claude.

## Il proxy non è una comodità

`vite.config.ts` inoltra `/api` e `/healthz` a `:3000` per tenere tutto **same-origin**
in sviluppo: il cookie di sessione è `httpOnly` + `SameSite=Lax`, quindi con la SPA su
`:5173` e l'API su `:3000` come origini distinte non verrebbe **mai** inviato — si
vedrebbe un login riuscito seguito da 401 su tutto. Aggiungendo un prefisso di rotta
nuovo, va aggiunto anche a quel `proxy`.

In produzione non c'è nessun server frontend: `web/dist` è servito dal backend
(`../src/static.ts`), con fallback SPA sul `notFoundHandler`.

## Numeri e date, sul filo

Denaro e quantità arrivano dall'API **come stringhe** e le date come `"YYYY-MM-DD"`
(vedi `../docs/decisions.md` §1 e §6). Non convertirli in `number` per visualizzarli:
la formattazione sta in `src/format.ts`, e un `parseFloat` in un componente è
esattamente il modo in cui una precisione decimale si perde a valle di tutto il lavoro
fatto per preservarla.

Le serie con punti `partial: true` vanno rese **tratteggiate**, non come uno zero: un
buco nei dati che sembra un crollo del portafoglio è la peggior modalità di
fallimento dell'app (§5).

## Log

`console.log` qui è normale: è il browser. La regola "mai `console`" riguarda il
backend, dove i log vanno raccolti via OTLP.
