-- Schema iniziale di portfolio-tracker.
--
-- Gli "enum" sono CHECK constraint, non tipi PG ENUM: aggiungere un valore
-- diventa una migrazione additiva invece di un ALTER TYPE, che non gira dentro
-- una transazione.
--
-- IF NOT EXISTS in abbondanza: una migrazione parzialmente applicata deve essere
-- ri-eseguibile.

CREATE TABLE IF NOT EXISTS portfolios (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  base_ccy   CHAR(3) NOT NULL DEFAULT 'EUR',
  broker     TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS instruments (
  id                SERIAL PRIMARY KEY,
  asset_class       TEXT NOT NULL CHECK (asset_class IN
                      ('EQUITY','ETF','BOND','FUND','CRYPTO','CASH')),   -- ultimi due = futuri
  name              TEXT NOT NULL,
  ticker            TEXT,                    -- simbolo provider, es. 'EUNL.DE'
  isin              TEXT,
  exchange          TEXT,
  currency          CHAR(3) NOT NULL,
  price_source      TEXT NOT NULL DEFAULT 'yahoo' CHECK (price_source IN ('yahoo','manual')),
  quote_convention  TEXT NOT NULL DEFAULT 'PRICE'
                      CHECK (quote_convention IN ('PRICE','PCT_OF_NOMINAL')),
  -- campi obbligazionari
  face_value        NUMERIC(20,6),           -- nominale per unità (1000, 100, …)
  coupon_rate       NUMERIC(12,8),           -- annuo come FRAZIONE: 0.0345 = 3,45%
  -- `IS NULL OR ...` esplicito sulle colonne NULLABLE con lista di valori: in
  -- Postgres un CHECK che vale NULL è già soddisfatto, quindi la guardia è
  -- semanticamente neutra — ma pg-mem (usato dai test locali, dato che qui non c'è
  -- Postgres) tratta `NULL IN (...)` come violazione. Costa nulla e rende lo schema
  -- verificabile in locale.
  coupon_frequency  SMALLINT CHECK (coupon_frequency IS NULL
                      OR coupon_frequency IN (0,1,2,4,12)),  -- 0 = zero coupon
  first_coupon_date DATE,
  maturity_date     DATE,
  day_count         TEXT DEFAULT 'ACT/ACT-ICMA'
                      CHECK (day_count IS NULL
                        OR day_count IN ('ACT/ACT-ICMA','30E/360','ACT/365F','ACT/360')),
  issuer            TEXT,
  metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,   -- valvola di estensibilità
  notes             TEXT,
  active            BOOLEAN NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT instruments_identity CHECK (ticker IS NOT NULL OR isin IS NOT NULL),
  CONSTRAINT instruments_bond_fields CHECK (
    asset_class <> 'BOND' OR (
      face_value IS NOT NULL AND coupon_frequency IS NOT NULL AND maturity_date IS NOT NULL
      AND (coupon_frequency = 0
           OR (coupon_rate IS NOT NULL AND first_coupon_date IS NOT NULL))))
);
CREATE UNIQUE INDEX IF NOT EXISTS instruments_isin_uq   ON instruments (isin)   WHERE isin IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS instruments_ticker_uq ON instruments (ticker) WHERE ticker IS NOT NULL;

CREATE TABLE IF NOT EXISTS transactions (
  id               SERIAL PRIMARY KEY,
  portfolio_id     INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
  instrument_id    INTEGER REFERENCES instruments(id) ON DELETE RESTRICT,
  type             TEXT NOT NULL CHECK (type IN
                     ('BUY','SELL','DIVIDEND','COUPON','INTEREST','FEE','TAX',
                      'SPLIT','DEPOSIT','WITHDRAWAL','RETURN_OF_CAPITAL')),
  trade_date       DATE NOT NULL,        -- data economica (ex-date per i redditi); guida tutta la matematica
  settle_date      DATE,
  quantity         NUMERIC(28,8),        -- SEMPRE POSITIVA; la direzione vive in `type`
  price            NUMERIC(20,8),        -- per unità in trade_ccy; % del nominale per i bond
  gross_amount     NUMERIC(20,6),        -- importo LORDO (dividendi: prima della ritenuta)
  fees             NUMERIC(20,6) NOT NULL DEFAULT 0,
  taxes            NUMERIC(20,6) NOT NULL DEFAULT 0,   -- ritenuta 26% / 12,5% / estera
  accrued_interest NUMERIC(20,6) NOT NULL DEFAULT 0,   -- bond: pagato in BUY, incassato in SELL
  net_amount       NUMERIC(20,6) NOT NULL,             -- effetto cassa CON SEGNO, in trade_ccy
  trade_ccy        CHAR(3) NOT NULL,
  fx_rate          NUMERIC(20,10),       -- EUR -> trade_ccy; NULL = risolvi da cache
  split_ratio      NUMERIC(20,10),       -- solo SPLIT: nuove/vecchie (2 = 2-per-1)
  note             TEXT,
  external_ref     TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tx_needs_instrument CHECK (type IN ('DEPOSIT','WITHDRAWAL') OR instrument_id IS NOT NULL),
  CONSTRAINT tx_trade_qty CHECK (type NOT IN ('BUY','SELL')
                                 OR (quantity IS NOT NULL AND quantity > 0 AND price IS NOT NULL)),
  CONSTRAINT tx_split CHECK (type <> 'SPLIT' OR (split_ratio IS NOT NULL AND split_ratio > 0)),
  CONSTRAINT tx_net_sign CHECK (
    (type IN ('BUY','FEE','TAX','WITHDRAWAL') AND net_amount <= 0) OR
    (type IN ('SELL','DIVIDEND','COUPON','INTEREST','DEPOSIT','RETURN_OF_CAPITAL') AND net_amount >= 0) OR
    (type = 'SPLIT' AND net_amount = 0))
);
CREATE INDEX IF NOT EXISTS tx_portfolio_date_idx  ON transactions (portfolio_id, trade_date, id);
CREATE INDEX IF NOT EXISTS tx_instrument_date_idx ON transactions (instrument_id, trade_date, id);

CREATE TABLE IF NOT EXISTS prices_daily (
  instrument_id INTEGER NOT NULL REFERENCES instruments(id) ON DELETE CASCADE,
  price_date    DATE NOT NULL,
  close         NUMERIC(20,8) NOT NULL,   -- in instrument.currency; % nominale per i bond
  adj_close     NUMERIC(20,8),            -- salvato, MAI usato per la valorizzazione (§3.4)
  open          NUMERIC(20,8),
  high          NUMERIC(20,8),
  low           NUMERIC(20,8),
  volume        NUMERIC(28,4),
  source        TEXT NOT NULL DEFAULT 'yahoo' CHECK (source IN ('yahoo','manual')),
  fetched_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (instrument_id, price_date)
);

CREATE TABLE IF NOT EXISTS quotes_latest (
  instrument_id  INTEGER PRIMARY KEY REFERENCES instruments(id) ON DELETE CASCADE,
  price          NUMERIC(20,8) NOT NULL,
  currency       CHAR(3) NOT NULL,
  previous_close NUMERIC(20,8),
  market_state   TEXT,
  quote_time     TIMESTAMPTZ,
  source         TEXT NOT NULL,
  fetched_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Convenzione di direzione, dichiarata UNA VOLTA e mai invertita ad hoc:
-- rate = unità di quote_ccy per 1 base_ccy. base_ccy è sempre 'EUR'.
-- Per convertire X -> EUR: importo / rate.
CREATE TABLE IF NOT EXISTS fx_rates_daily (
  rate_date  DATE NOT NULL,
  base_ccy   CHAR(3) NOT NULL,
  quote_ccy  CHAR(3) NOT NULL,
  rate       NUMERIC(20,10) NOT NULL,
  source     TEXT NOT NULL DEFAULT 'frankfurter',
  is_filled  BOOLEAN NOT NULL DEFAULT FALSE,   -- TRUE = forward-filled, non pubblicato
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (rate_date, base_ccy, quote_ccy)
);

CREATE TABLE IF NOT EXISTS income_events (
  id              SERIAL PRIMARY KEY,
  instrument_id   INTEGER NOT NULL REFERENCES instruments(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN ('DIVIDEND','COUPON','SPLIT','REDEMPTION')),
  status          TEXT NOT NULL CHECK (status IN ('PROJECTED','ANNOUNCED','PAID')),
  ex_date         DATE,
  pay_date        DATE NOT NULL,
  amount_per_unit NUMERIC(20,8),      -- dividendi: per azione; cedole: per 100 di nominale
  currency        CHAR(3) NOT NULL,
  split_ratio     NUMERIC(20,10),
  source          TEXT NOT NULL CHECK (source IN ('yahoo','schedule','manual')),
  transaction_id  INTEGER REFERENCES transactions(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS income_events_natural_uq
  ON income_events (instrument_id, kind, pay_date, COALESCE(ex_date, DATE '1900-01-01'));
CREATE INDEX IF NOT EXISTS income_events_paydate_idx ON income_events (pay_date);

CREATE TABLE IF NOT EXISTS refresh_log (
  id          SERIAL PRIMARY KEY,
  job         TEXT NOT NULL,      -- 'quotes' | 'history' | 'fx' | 'events'
  target      TEXT,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  ok          BOOLEAN,
  error       TEXT,
  row_count   INTEGER
);
CREATE INDEX IF NOT EXISTS refresh_log_job_idx ON refresh_log (job, started_at DESC);

CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
