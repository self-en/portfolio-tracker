-- Portafoglio di default, così l'app è usabile senza un passaggio di setup.
INSERT INTO portfolios (name, base_ccy) VALUES ('Principale','EUR')
  ON CONFLICT (name) DO NOTHING;
