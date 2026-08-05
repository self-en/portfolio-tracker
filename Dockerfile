# Stage 1 — build della SPA.
#
# --platform=$BUILDPLATFORM inchioda questo stage all'architettura del builder.
# L'output è JavaScript, CSS e sourcemap: artefatti indipendenti dall'architettura,
# identici qualunque sia la piattaforma di destinazione. Senza questo, il leg arm64
# di una build multi-arch farebbe girare npm ci + vite sotto emulazione QEMU —
# minuti di compilazione emulata per produrre gli stessi byte.
FROM --platform=$BUILDPLATFORM node:24-alpine AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# Stage 2 — dipendenze runtime del server, senza le dev.
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Stage 2b — compilazione del backend TypeScript (tsc -> build/).
#
# Anche questo stage è inchiodato al builder: l'output è JavaScript, identico su
# ogni architettura, e compilarlo sotto QEMU per il leg arm64 sarebbe tempo
# regalato. Le migrazioni .sql vengono copiate accanto al JS emesso perché
# db/migrations/index le legge da __dirname a runtime.
FROM --platform=$BUILDPLATFORM node:24-alpine AS server
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Stage 3 — immagine finale: nessun toolchain, nessuna sorgente della SPA.
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3000
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY --from=server /app/build ./build
COPY --from=web /web/dist ./web/dist
# La dichiarazione delle variabili: src/platform/config.ts la legge a runtime per
# servire /_self-en/config e sapere cosa manca.
COPY self-en.json ./
EXPOSE 3000

# start-period=10s: al boot girano le migrazioni sotto advisory lock, e su un
# database appena creato non sono istantanee. /healthz risponde 200 già da subito
# (listen() precede le migrazioni), ma il margine evita che un container lento
# venga dichiarato unhealthy prima di aver finito.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD wget -qO- http://localhost:3000/healthz || exit 1
USER node
CMD ["node", "build/server.js"]
