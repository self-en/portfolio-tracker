import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { del, get, patch } from "../api";
import { DASH, num } from "../format";
import DataTable from "../components/DataTable";
import Drawer from "../components/Drawer";
import ConfirmDialog from "../components/ConfirmDialog";
import EmptyState from "../components/EmptyState";
import InstrumentForm from "../components/InstrumentForm";
import StaleBadge from "../components/StaleBadge";
import { useToast } from "../components/Toast";
import { ApiError } from "../api";
import type { Column } from "../components/DataTable";
import type { Instrument, InstrumentsResponse } from "../types";

const ASSET_CLASS_LABELS: Record<string, string> = {
  EQUITY: "Azione",
  ETF: "ETF",
  BOND: "Obbligazione",
  FUND: "Fondo",
  CRYPTO: "Cripto",
  CASH: "Liquidità",
};

const PRICE_SOURCE_LABELS: Record<string, string> = { yahoo: "Provider", manual: "Manuale" };

/** Cosa sta facendo il drawer: creare uno strumento, o modificarne uno esistente. */
type DrawerState = { mode: "create" } | { mode: "edit"; instrument: Instrument };

export default function Instruments() {
  const queryClient = useQueryClient();
  const toast = useToast();

  const [q, setQ] = useState("");
  const [assetClass, setAssetClass] = useState("");
  const [onlyActive, setOnlyActive] = useState(true);
  const [drawer, setDrawer] = useState<DrawerState | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Instrument | null>(null);
  // L'errore di cancellazione è tipizzato ApiError perché il caso che conta è il
  // 409 "ha movimenti collegati", che apre l'alternativa "disattiva invece".
  const [deleteError, setDeleteError] = useState<ApiError | null>(null);

  const params = useMemo(
    () => ({
      q: q.trim() || undefined,
      assetClass: assetClass || undefined,
      active: onlyActive ? "true" : undefined,
    }),
    [q, assetClass, onlyActive]
  );

  const list = useQuery({
    queryKey: ["instruments", "list", params],
    queryFn: ({ signal }) => get<InstrumentsResponse>("/instruments", { query: params, signal }),
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["instruments"] });
    queryClient.invalidateQueries({ queryKey: ["portfolio"] });
  };

  const remove = useMutation<unknown, ApiError, number>({
    mutationFn: (id) => del(`/instruments/${id}`),
    onSuccess: () => {
      invalidate();
      toast.success("Strumento eliminato.");
      setPendingDelete(null);
      setDeleteError(null);
    },
    // Il 409 con i movimenti collegati non è un fallimento da nascondere: si mostra
    // il messaggio del server e si propone la disattivazione, che è la via corretta.
    onError: (err) => setDeleteError(err),
  });

  const deactivate = useMutation<unknown, ApiError, Instrument>({
    mutationFn: (instrument) =>
      patch(`/instruments/${instrument.id}`, {
        active: false,
        // priceSource e quoteConvention viaggiano insieme ad `active` perché lo
        // schema PATCH del server è `partial()` ma mantiene i default degli enum:
        // omettendoli, un'obbligazione manuale tornerebbe a priceSource "yahoo" e la
        // rivalidazione la rifiuterebbe con un 422 (verificato con curl).
        priceSource: instrument.priceSource,
        quoteConvention: instrument.quoteConvention,
      }),
    onSuccess: () => {
      invalidate();
      toast.success("Strumento disattivato: resta nello storico, non viene più aggiornato.");
      setPendingDelete(null);
      setDeleteError(null);
    },
    onError: (err) => setDeleteError(err),
  });

  const columns = useMemo<Array<Column<Instrument>>>(
    () => [
      {
        key: "name",
        header: "Nome",
        render: (i) => (
          <span className="cell-instrument">
            <Link to={`/strumenti/${i.id}`}>{i.name}</Link>
            {i.active === false ? <span className="badge">disattivato</span> : null}
          </span>
        ),
      },
      { key: "ticker", header: "Ticker", render: (i) => i.ticker || DASH },
      {
        key: "isin",
        header: "ISIN",
        hideOnNarrow: true,
        render: (i) => <span className="num">{i.isin || DASH}</span>,
      },
      {
        key: "assetClass",
        header: "Classe",
        render: (i) => (i.assetClass && ASSET_CLASS_LABELS[i.assetClass]) || i.assetClass,
      },
      { key: "currency", header: "Valuta", hideOnNarrow: true, render: (i) => i.currency },
      {
        key: "priceSource",
        header: "Sorgente prezzo",
        hideOnNarrow: true,
        render: (i) => (
          <span>
            {(i.priceSource && PRICE_SOURCE_LABELS[i.priceSource]) || i.priceSource}
            {i.quoteConvention === "PCT_OF_NOMINAL" ? (
              <span className="muted small"> · % nominale</span>
            ) : null}
          </span>
        ),
      },
      {
        key: "latestQuote",
        header: "Ultima quotazione",
        align: "right",
        render: (i) => (
          <span className="cell-quote">
            <span className="num">
              {i.latestQuote?.price
                ? i.quoteConvention === "PCT_OF_NOMINAL"
                  ? `${num(i.latestQuote.price, 4)} %`
                  : num(i.latestQuote.price, 4)
                : DASH}
            </span>
            <StaleBadge asOf={i.latestQuote?.asOf} stale={!i.latestQuote} />
          </span>
        ),
      },
      {
        key: "actions",
        header: "Azioni",
        align: "right",
        render: (i) => (
          <span className="row row--tight">
            <Link className="btn btn--small" to={`/strumenti/${i.id}`}>
              Dettaglio
            </Link>
            <button
              type="button"
              className="btn btn--small"
              onClick={() => setDrawer({ mode: "edit", instrument: i })}
            >
              Modifica
            </button>
            <button
              type="button"
              className="btn btn--small btn--danger-ghost"
              onClick={() => {
                setDeleteError(null);
                setPendingDelete(i);
              }}
            >
              Elimina
            </button>
          </span>
        ),
      },
    ],
    []
  );

  return (
    <>
      <div className="page-head">
        <h1>Strumenti</h1>
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => setDrawer({ mode: "create" })}
        >
          Nuovo strumento
        </button>
      </div>

      <div className="filterbar card">
        <div className="filterbar-row">
          <label className="field field--inline field--grow">
            <span className="field-label">Ricerca</span>
            <input
              className="input"
              type="search"
              placeholder="nome, ticker o ISIN"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </label>
          <label className="field field--inline">
            <span className="field-label">Classe</span>
            <select
              className="select"
              value={assetClass}
              onChange={(e) => setAssetClass(e.target.value)}
            >
              <option value="">Tutte</option>
              {Object.entries(ASSET_CLASS_LABELS).map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="field field--check field--inline">
            <input
              type="checkbox"
              checked={onlyActive}
              onChange={(e) => setOnlyActive(e.target.checked)}
            />
            <span>Solo attivi</span>
          </label>
        </div>
      </div>

      <DataTable
        caption="Anagrafica degli strumenti"
        columns={columns}
        rows={list.data?.items ?? []}
        rowKey={(i) => i.id}
        loading={list.isPending}
        error={list.error}
        onRetry={() => list.refetch()}
        empty={
          <EmptyState
            title="Nessuno strumento"
            message="Crea il primo strumento: la ricerca compila ticker e nome dove il provider arriva, le obbligazioni si inseriscono a mano."
            action={
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => setDrawer({ mode: "create" })}
              >
                Nuovo strumento
              </button>
            }
          />
        }
      />

      <Drawer
        open={Boolean(drawer)}
        title={drawer?.mode === "edit" ? "Modifica strumento" : "Nuovo strumento"}
        subtitle={drawer?.mode === "edit" ? drawer.instrument.name : undefined}
        onClose={() => setDrawer(null)}
      >
        {drawer ? (
          <InstrumentForm
            key={drawer.mode === "edit" ? `edit-${drawer.instrument.id}` : "create"}
            instrument={drawer.mode === "edit" ? drawer.instrument : null}
            onSaved={() => {
              toast.success("Strumento salvato.");
              setDrawer(null);
            }}
            onCancel={() => setDrawer(null)}
          />
        ) : null}
      </Drawer>

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        title="Eliminare lo strumento?"
        message={
          deleteError
            ? deleteError.message
            : pendingDelete
              ? `${pendingDelete.name} verrà rimosso dall'anagrafica.`
              : null
        }
        detail={
          deleteError
            ? "Disattivandolo resta nello storico e nei movimenti, ma non viene più aggiornato né proposto nei form."
            : "Possibile solo se non ha movimenti collegati."
        }
        confirmLabel={deleteError ? "Riprova a eliminare" : "Elimina"}
        danger
        busy={remove.isPending || deactivate.isPending}
        extraAction={
          deleteError?.status === 409 ? (
            <button
              type="button"
              className="btn"
              onClick={() => pendingDelete && deactivate.mutate(pendingDelete)}
              disabled={deactivate.isPending}
            >
              Disattiva invece
            </button>
          ) : null
        }
        onConfirm={() => pendingDelete && remove.mutate(pendingDelete.id)}
        onCancel={() => {
          setPendingDelete(null);
          setDeleteError(null);
        }}
      />
    </>
  );
}
