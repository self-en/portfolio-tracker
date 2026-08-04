import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { get, post } from "../api.js";
import { DASH, date as fmtDate, dateTime, num, pct } from "../format.js";
import DataTable from "../components/DataTable.jsx";
import Drawer from "../components/Drawer.jsx";
import EmptyState from "../components/EmptyState.jsx";
import InstrumentForm from "../components/InstrumentForm.jsx";
import ManualPriceForm from "../components/ManualPriceForm.jsx";
import Spinner from "../components/Spinner.jsx";
import StaleBadge from "../components/StaleBadge.jsx";
import WarningsBanner from "../components/WarningsBanner.jsx";
import { useToast } from "../components/Toast.jsx";

const ASSET_CLASS_LABELS = {
  EQUITY: "Azione",
  ETF: "ETF",
  BOND: "Obbligazione",
  FUND: "Fondo",
  CRYPTO: "Cripto",
  CASH: "Liquidità",
};

const FREQUENCY_LABELS = {
  0: "zero coupon",
  1: "annuale",
  2: "semestrale",
  4: "trimestrale",
  12: "mensile",
};

function Row({ label, children }) {
  return (
    <div className="detail-row">
      <dt>{label}</dt>
      <dd>{children ?? DASH}</dd>
    </div>
  );
}

export default function InstrumentDetail() {
  const { id } = useParams();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState(false);

  const detail = useQuery({
    queryKey: ["instruments", "detail", id],
    queryFn: ({ signal }) => get(`/instruments/${id}`, { signal }),
  });

  const refresh = useMutation({
    mutationFn: () => post(`/instruments/${id}/refresh`),
    onSuccess: () => {
      // 202: accodato, non eseguito. Il prezzo arriverà quando il refresher avrà
      // finito, quindi si invalida senza promettere che il dato sia già cambiato.
      queryClient.invalidateQueries({ queryKey: ["instruments"] });
      toast.success("Aggiornamento richiesto: i prezzi arriveranno a breve.");
    },
    onError: (err) => toast.error(`Aggiornamento non richiesto: ${err.message}`),
  });

  if (detail.isPending) return <Spinner />;

  if (detail.error) {
    return (
      <>
        <div className="page-head">
          <h1>Strumento</h1>
          <Link className="btn" to="/strumenti">
            Torna agli strumenti
          </Link>
        </div>
        <EmptyState
          title="Dettaglio non disponibile"
          message={detail.error.message}
          action={
            <button type="button" className="btn" onClick={() => detail.refetch()}>
              Riprova
            </button>
          }
        />
      </>
    );
  }

  const inst = detail.data;
  const bond = inst.bond || null;
  const isBond = inst.assetClass === "BOND";
  const isPctQuote = inst.quoteConvention === "PCT_OF_NOMINAL";
  const manual = inst.priceSource === "manual";
  const coverage = inst.priceCoverage || {};
  const schedule = inst.couponSchedule ?? [];

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="detail-title">
            {inst.name}
            {inst.active === false ? <span className="badge">disattivato</span> : null}
          </h1>
          <p className="muted small">
            {[
              ASSET_CLASS_LABELS[inst.assetClass] || inst.assetClass,
              inst.ticker,
              inst.isin,
              inst.exchange,
              inst.currency,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        <div className="row row--tight">
          <Link className="btn" to="/strumenti">
            Strumenti
          </Link>
          <Link className="btn" to="/movimenti">
            Movimenti
          </Link>
          <button type="button" className="btn" onClick={() => setEditing(true)}>
            Modifica
          </button>
        </div>
      </div>

      <WarningsBanner warnings={inst.warnings} />

      <div className="grid grid--2">
        <section className="card">
          <h2 className="card-title">Anagrafica</h2>
          <dl className="detail-list">
            <Row label="Classe">{ASSET_CLASS_LABELS[inst.assetClass] || inst.assetClass}</Row>
            <Row label="Ticker">{inst.ticker}</Row>
            <Row label="ISIN">{inst.isin}</Row>
            <Row label="Borsa">{inst.exchange}</Row>
            <Row label="Valuta">{inst.currency}</Row>
            <Row label="Sorgente del prezzo">
              {manual ? "manuale" : "provider di mercato"}
            </Row>
            <Row label="Convenzione di quotazione">
              {isPctQuote ? "percentuale del nominale" : "prezzo per quota"}
            </Row>
            {inst.issuer ? <Row label="Emittente">{inst.issuer}</Row> : null}
            {inst.notes ? <Row label="Note">{inst.notes}</Row> : null}
          </dl>
        </section>

        <section className="card">
          <h2 className="card-title">Prezzi</h2>
          <dl className="detail-list">
            <Row label="Ultima quotazione">
              <span className="row row--tight">
                <span className="num">
                  {inst.latestQuote?.price
                    ? isPctQuote
                      ? `${num(inst.latestQuote.price, 4)} %`
                      : num(inst.latestQuote.price, 4)
                    : DASH}
                </span>
                <StaleBadge asOf={inst.latestQuote?.asOf} stale={!inst.latestQuote} />
              </span>
            </Row>
            <Row label="Rilevata il">
              {inst.latestQuote?.asOf ? dateTime(inst.latestQuote.asOf) : null}
            </Row>
            <Row label="Fonte della quotazione">{inst.latestQuote?.source}</Row>
            <Row label="Copertura storica">
              {coverage.from
                ? `${fmtDate(coverage.from)} → ${fmtDate(coverage.to)} (${coverage.rows} rilevazioni)`
                : "nessun prezzo in archivio"}
            </Row>
          </dl>

          <div className="row">
            <button
              type="button"
              className="btn"
              onClick={() => refresh.mutate()}
              disabled={manual || refresh.isPending}
              title={
                manual
                  ? "Sorgente manuale: non c'è nulla da scaricare online"
                  : "Richiede un aggiornamento al provider"
              }
            >
              {refresh.isPending ? <Spinner inline label="Richiesta…" /> : "Aggiorna ora"}
            </button>
            {manual ? (
              <span className="muted small">
                Sorgente manuale: non c'è nulla da scaricare. Il prezzo si inserisce qui sotto.
              </span>
            ) : null}
          </div>
        </section>
      </div>

      {/* Il prezzo manuale è IL percorso normale per le obbligazioni, quindi sta in
          alto e a piena larghezza, non in fondo tra le opzioni avanzate. */}
      <section className={manual ? "card card--accent" : "card"}>
        {isBond ? (
          <p className="form-note">
            Le obbligazioni non hanno copertura di mercato: il provider non restituisce quotazioni
            per i titoli di Stato. Inserire il corso qui è il modo previsto per tenere aggiornata la
            valorizzazione di questo titolo.
          </p>
        ) : null}
        <ManualPriceForm instrument={inst} lastPrice={inst.latestQuote?.price} />
      </section>

      <section className="card">
        <h2 className="card-title">Andamento del prezzo</h2>
        {/* Fase 8: PriceChart */}
        <EmptyState message="Il grafico del prezzo arriva con la fase dei grafici." />
      </section>

      {bond ? (
        <section className="card">
          <h2 className="card-title">Dati obbligazionari</h2>
          <dl className="detail-list detail-list--inline">
            <Row label="Valore facciale">{bond.faceValue ? num(bond.faceValue, 2) : null}</Row>
            <Row label="Tasso cedolare">
              {bond.couponRate ? pct(bond.couponRate, 3) : null}
            </Row>
            <Row label="Frequenza">
              {bond.couponFrequency === null || bond.couponFrequency === undefined
                ? null
                : FREQUENCY_LABELS[bond.couponFrequency] || bond.couponFrequency}
            </Row>
            <Row label="Prima cedola">{bond.firstCouponDate ? fmtDate(bond.firstCouponDate) : null}</Row>
            <Row label="Scadenza">{bond.maturityDate ? fmtDate(bond.maturityDate) : null}</Row>
            <Row label="Convenzione giorni">{bond.dayCount}</Row>
            {inst.currentYield ? (
              <Row label="Rendimento corrente">{pct(inst.currentYield, 2)}</Row>
            ) : null}
          </dl>
          <p className="muted small">
            Il tasso cedolare è memorizzato come frazione annua e mostrato in percentuale. Il
            rendimento corrente è cedola annua ÷ corso secco: non è il rendimento a scadenza.
          </p>
        </section>
      ) : null}

      {isBond ? (
        <section className="card">
          <h2 className="card-title">Scadenzario cedolare</h2>
          <p className="muted small">
            Generato all'indietro dalla scadenza: l'eventuale periodo irregolare cade all'inizio,
            dove deve stare. Gli importi sono per 100 di nominale.
          </p>
          <DataTable
            caption="Scadenzario cedolare"
            columns={[
              {
                key: "payDate",
                header: "Pagamento",
                render: (p) => <span className="num">{fmtDate(p.payDate)}</span>,
              },
              {
                key: "period",
                header: "Periodo di maturazione",
                render: (p) => (
                  <span className="num">
                    {fmtDate(p.periodStart)} → {fmtDate(p.periodEnd)}
                  </span>
                ),
              },
              {
                key: "amountPer100",
                header: "Importo per 100 di nominale",
                align: "right",
                render: (p) => <span className="num">{num(p.amountPer100, 5)}</span>,
              },
              {
                key: "irregular",
                header: "Note",
                render: (p) =>
                  p.irregular ? (
                    <span
                      className="badge badge--stale"
                      title="Periodo di maturazione diverso dal periodo cedolare pieno: l'importo è proratato"
                    >
                      irregolare
                    </span>
                  ) : (
                    <span className="muted">{DASH}</span>
                  ),
              },
            ]}
            rows={schedule}
            rowKey={(p) => p.payDate}
            empty={
              <EmptyState
                message={
                  bond?.couponFrequency === 0
                    ? "Zero coupon: nessuna cedola, solo il rimborso a scadenza."
                    : "Nessuna cedola generata: controlla tasso, frequenza e date."
                }
              />
            }
          />
        </section>
      ) : null}

      <Drawer
        open={editing}
        title="Modifica strumento"
        subtitle={inst.name}
        onClose={() => setEditing(false)}
      >
        {editing ? (
          <InstrumentForm
            instrument={inst}
            onSaved={() => {
              toast.success("Strumento salvato.");
              setEditing(false);
            }}
            onCancel={() => setEditing(false)}
          />
        ) : null}
      </Drawer>
    </>
  );
}
