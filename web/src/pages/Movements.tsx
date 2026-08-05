import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { del, get } from "../api";
import { DASH, date as fmtDate, money, num, qty as fmtQty } from "../format";
import { useApp } from "../AppContext";
import DataTable from "../components/DataTable";
import Drawer from "../components/Drawer";
import ConfirmDialog from "../components/ConfirmDialog";
import EmptyState from "../components/EmptyState";
import FilterBar, { TypeBadge, txTypeLabel } from "../components/FilterBar";
import Money from "../components/Money";
import Spinner from "../components/Spinner";
import TransactionForm from "../components/TransactionForm";
import { useToast } from "../components/Toast";

const PAGE_SIZE = 50;

const EMPTY_FILTERS = { types: [], instrumentId: null, from: null, to: null, q: "" };

/** Ricerca testuale locale: l'API dei movimenti non ha un parametro di testo libero. */
function matchesQuery(tx, q) {
  if (!q) return true;
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  const haystack = [
    tx.instrument?.name,
    tx.instrument?.ticker,
    tx.instrument?.isin,
    tx.note,
    tx.externalRef,
    txTypeLabel(tx.type),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes(needle);
}

export default function Movements() {
  const { portfolioId } = useApp();
  const queryClient = useQueryClient();
  const toast = useToast();

  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [drawer, setDrawer] = useState(null); // null | {mode:'create'} | {mode:'edit', tx}
  const [pendingDelete, setPendingDelete] = useState(null);

  const instrumentsQuery = useQuery({
    queryKey: ["instruments", { active: "true" }],
    queryFn: ({ signal }) => get("/instruments", { query: { active: "true" }, signal }),
  });

  const listParams = useMemo(
    () => ({
      portfolioId: portfolioId || undefined,
      instrumentId: filters.instrumentId || undefined,
      // Il server accetta i tipi come lista separata da virgole.
      type: filters.types.length > 0 ? filters.types.join(",") : undefined,
      from: filters.from || undefined,
      to: filters.to || undefined,
      limit: PAGE_SIZE,
    }),
    [portfolioId, filters.instrumentId, filters.types, filters.from, filters.to]
  );

  const list = useInfiniteQuery({
    queryKey: ["transactions", "list", listParams],
    // Paginazione KEYSET: il cursore arriva dalla risposta precedente. Con OFFSET
    // l'inserimento di un movimento durante lo scroll farebbe ricomparire o saltare
    // righe già viste.
    queryFn: ({ pageParam, signal }) =>
      get("/transactions", { query: { ...listParams, cursor: pageParam || undefined }, signal }),
    initialPageParam: null,
    getNextPageParam: (lastPage) => lastPage?.nextCursor ?? undefined,
  });

  const rows = useMemo(() => {
    const all = (list.data?.pages ?? []).flatMap((p) => p.items ?? []);
    return all.filter((tx) => matchesQuery(tx, filters.q));
  }, [list.data, filters.q]);

  const loadedCount = useMemo(
    () => (list.data?.pages ?? []).reduce((n, p) => n + (p.items?.length ?? 0), 0),
    [list.data]
  );

  // Sentinella per lo scroll infinito. Il bottone "Carica altri" resta comunque
  // visibile: l'IntersectionObserver non scatta se la finestra non scorre.
  const sentinel = useRef(null);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = list;
  useEffect(() => {
    const node = sentinel.current;
    if (!node || !hasNextPage) return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && !isFetchingNextPage) fetchNextPage();
      },
      { rootMargin: "300px" }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const remove = useMutation({
    mutationFn: (id) => del(`/transactions/${id}`),
    onSuccess: () => {
      for (const key of [["portfolio"], ["transactions"], ["calendar"]]) {
        queryClient.invalidateQueries({ queryKey: key });
      }
      toast.success("Movimento eliminato.");
      setPendingDelete(null);
    },
    onError: (err) => {
      toast.error(`Eliminazione non riuscita: ${err.message}`);
      setPendingDelete(null);
    },
  });

  const onSaved = useCallback(() => {
    toast.success("Movimento salvato.");
    setDrawer(null);
  }, [toast]);

  const columns = useMemo(
    () => [
      {
        key: "tradeDate",
        header: "Data",
        render: (tx) => <span className="num">{fmtDate(tx.tradeDate)}</span>,
      },
      { key: "type", header: "Tipo", render: (tx) => <TypeBadge type={tx.type} /> },
      {
        key: "instrument",
        header: "Strumento",
        render: (tx) =>
          tx.instrument ? (
            <span className="cell-instrument">
              <span className="cell-instrument-name">{tx.instrument.name}</span>
              {tx.instrument.ticker || tx.instrument.isin ? (
                <span className="muted small">{tx.instrument.ticker || tx.instrument.isin}</span>
              ) : null}
            </span>
          ) : (
            <span className="muted">{DASH}</span>
          ),
      },
      {
        key: "quantity",
        header: "Quantità",
        align: "right",
        render: (tx) => <span className="num">{tx.quantity === null ? DASH : fmtQty(tx.quantity)}</span>,
      },
      {
        key: "price",
        header: "Prezzo",
        align: "right",
        hideOnNarrow: true,
        render: (tx) => (
          <span className="num">
            {tx.price === null
              ? DASH
              : tx.instrument?.quoteConvention === "PCT_OF_NOMINAL"
                ? `${num(tx.price, 4)} %`
                : money(tx.price, tx.tradeCcy)}
          </span>
        ),
      },
      {
        key: "grossAmount",
        header: "Lordo",
        align: "right",
        hideOnNarrow: true,
        render: (tx) => <Money value={tx.grossAmount} ccy={tx.tradeCcy} />,
      },
      {
        key: "costs",
        header: "Comm./imposte",
        align: "right",
        hideOnNarrow: true,
        render: (tx) => (
          <span className="num cell-costs">
            {money(tx.fees, tx.tradeCcy)}
            <span className="muted"> / </span>
            {money(tx.taxes, tx.tradeCcy)}
          </span>
        ),
      },
      {
        key: "netAmount",
        header: "Netto",
        align: "right",
        render: (tx) => <Money value={tx.netAmount} ccy={tx.tradeCcy} withSign tone />,
      },
      { key: "tradeCcy", header: "Valuta", hideOnNarrow: true, render: (tx) => tx.tradeCcy },
      {
        key: "actions",
        header: "Azioni",
        align: "right",
        render: (tx) => (
          <span className="row row--tight">
            <button
              type="button"
              className="btn btn--small"
              onClick={() => setDrawer({ mode: "edit", tx })}
            >
              Modifica
            </button>
            <button
              type="button"
              className="btn btn--small btn--danger-ghost"
              onClick={() => setPendingDelete(tx)}
            >
              Elimina
            </button>
          </span>
        ),
      },
    ],
    []
  );

  const filtersActive =
    filters.types.length > 0 || filters.instrumentId || filters.from || filters.to || filters.q;

  return (
    <>
      <div className="page-head">
        <h1>Movimenti</h1>
        <button type="button" className="btn btn--primary" onClick={() => setDrawer({ mode: "create" })}>
          Nuovo movimento
        </button>
      </div>

      <FilterBar
        value={filters}
        onChange={setFilters}
        instruments={instrumentsQuery.data?.items ?? []}
        instrumentsError={instrumentsQuery.error}
      />

      <DataTable
        caption="Elenco dei movimenti"
        columns={columns}
        rows={rows}
        rowKey={(tx) => tx.id}
        loading={list.isPending}
        error={list.error}
        onRetry={() => list.refetch()}
        empty={
          <EmptyState
            title={filtersActive ? "Nessun movimento con questi filtri" : "Nessun movimento"}
            message={
              filtersActive
                ? loadedCount > 0
                  ? "I filtri escludono tutti i movimenti caricati. Prova ad allargare il periodo o ad azzerare i filtri."
                  : "Nessun movimento corrisponde ai filtri impostati."
                : "Registra il primo movimento: acquisti, vendite, cedole e versamenti si inseriscono da qui."
            }
            action={
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => setDrawer({ mode: "create" })}
              >
                Nuovo movimento
              </button>
            }
          />
        }
      />

      {rows.length > 0 ? (
        <div className="list-foot">
          <span className="muted small">
            {rows.length === loadedCount
              ? `${loadedCount} movimenti caricati`
              : `${rows.length} di ${loadedCount} movimenti caricati corrispondono alla ricerca`}
          </span>
          <span ref={sentinel} aria-hidden="true" />
          {list.hasNextPage ? (
            <button
              type="button"
              className="btn"
              onClick={() => list.fetchNextPage()}
              disabled={list.isFetchingNextPage}
            >
              {list.isFetchingNextPage ? <Spinner inline label="Caricamento…" /> : "Carica altri"}
            </button>
          ) : (
            <span className="muted small">fine dell'elenco</span>
          )}
        </div>
      ) : null}

      <Drawer
        open={Boolean(drawer)}
        title={drawer?.mode === "edit" ? "Modifica movimento" : "Nuovo movimento"}
        subtitle={
          drawer?.mode === "edit"
            ? `${txTypeLabel(drawer.tx.type)} del ${fmtDate(drawer.tx.tradeDate)}`
            : "Gli importi vengono calcolati dal server mentre scrivi."
        }
        onClose={() => setDrawer(null)}
      >
        {drawer ? (
          <TransactionForm
            // La key rimonta il form quando cambia il movimento in modifica:
            // altrimenti lo stato del form precedente sopravvivrebbe.
            key={drawer.mode === "edit" ? `edit-${drawer.tx.id}` : "create"}
            transaction={drawer.mode === "edit" ? drawer.tx : null}
            onSaved={onSaved}
            onCancel={() => setDrawer(null)}
          />
        ) : null}
      </Drawer>

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        title="Eliminare il movimento?"
        message={
          pendingDelete
            ? `${txTypeLabel(pendingDelete.type)} del ${fmtDate(pendingDelete.tradeDate)}${
                pendingDelete.instrument ? ` su ${pendingDelete.instrument.name}` : ""
              }, effetto di cassa ${money(pendingDelete.netAmount, pendingDelete.tradeCcy)}.`
            : null
        }
        detail="Un movimento eliminato non si recupera: posizioni, valorizzazione e calendario vengono ricalcolati senza di esso."
        confirmLabel="Elimina definitivamente"
        danger
        busy={remove.isPending}
        onConfirm={() => remove.mutate(pendingDelete.id)}
        onCancel={() => setPendingDelete(null)}
      />
    </>
  );
}
