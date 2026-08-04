#!/bin/sh
# La piattaforma NON inoltra console.* via OTLP: un console.log su `main` è un log
# che scompare. Questo check cerca le CHIAMATE (le menzioni nei commenti vanno
# bene) in tutto il codice del server.
#
# Nota: il logger di DEFAULT di yahoo-finance2 è console.* — è l'adapter pino in
# src/market/yahooProvider.js a prevenire una violazione silenziosa che questo
# grep non potrebbe vedere.
set -e
cd "$(dirname "$0")/.."

hits=$(grep -rnE '(^|[^a-zA-Z.])console\.(log|warn|error|info|debug|dir|trace|table)[[:space:]]*\(' \
  src/ server.js 2>/dev/null || true)

if [ -n "$hits" ]; then
  echo "VIOLAZIONE: chiamate a console.* nel codice del server (usa src/logger.js):"
  echo "$hits"
  exit 1
fi
echo "OK: nessuna chiamata a console.* in src/ o server.js"
