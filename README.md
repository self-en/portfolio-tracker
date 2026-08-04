# portfolio-tracker

This repository was scaffolded by the **self-en** branch-env platform. It's a
minimal Node/Express starter that already satisfies the platform's deploy
contract, so you get a live env for every branch with no extra setup.

## How envs work

- Push any branch → GitHub Actions (`.github/workflows/ci.yml`) builds a Docker
  image and pushes it to `ghcr.io/self-en/portfolio-tracker/portfolio-tracker`, tagged with the
  immutable `sha-<short>` of the commit.
- The platform's ArgoCD `ApplicationSet` notices the branch and deploys the Helm
  chart in `chart/`, giving the branch its own env at
  `http://<branch>-<repo-hash>.self-en.uk/` and its own database.
- Delete the branch → the env and its database are cleaned up automatically.

## Layout

- `server.js` / `package.json` — the app (edit these).
- `Dockerfile` — how the image is built.
- `chart/` — the Helm chart the platform deploys (Deployment + Service +
  HTTPRoute + a PreSync hook that creates this branch's database). You rarely
  need to touch this.
- `.github/workflows/ci.yml` — builds and pushes the per-branch image.

## Observability (automatica sul branch `main`)

Sul solo branch `main` la piattaforma abilita OpenTelemetry senza che tu debba
fare nulla: **trace**, **metriche** e **log** vengono esportati via OTLP verso il
collector della piattaforma (Alloy → Tempo / Prometheus / Loki) e sono
consultabili in Grafana.

- **Trace + metriche**: strumentazione automatica di `express`/`pg`/`http` e del
  runtime Node (nessuna riga di codice richiesta).
- **Log**: l'app logga tramite [`pino`](https://getpino.io/) (vedi `server.js`).
  Ogni log diventa un record OTLP correlato al trace attivo (`trace_id`/`span_id`)
  e resta anche su stdout. Se aggiungi log, usa `logger`, non `console.log`
  (quest'ultimo NON viene inviato via OTLP).

Sugli altri branch la strumentazione non viene caricata (nessun endpoint a cui
esportare); `pino` continua a scrivere su stdout.

## Run locally

```bash
npm install
npm start   # http://localhost:3000
```
