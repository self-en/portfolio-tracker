import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { del, get } from "../api";
import DataTable from "../components/DataTable";
import Drawer from "../components/Drawer";
import ConfirmDialog from "../components/ConfirmDialog";
import EmptyState from "../components/EmptyState";
import PortfolioForm from "../components/PortfolioForm";
import { useToast } from "../components/Toast";
import { ApiError } from "../api";
import type { Column } from "../components/DataTable";
import type { Portfolio, PortfoliosResponse } from "../types";

/** Cosa sta facendo il drawer: creare un portafoglio, o modificarne uno esistente. */
type DrawerState = { mode: "create" } | { mode: "edit"; portfolio: Portfolio };

export default function Portfolios() {
  const queryClient = useQueryClient();
  const toast = useToast();

  const [drawer, setDrawer] = useState<DrawerState | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Portfolio | null>(null);
  // Il 409 "ha movimenti collegati" è il caso che conta: si mostra il messaggio
  // del server invece di un errore generico.
  const [deleteError, setDeleteError] = useState<ApiError | null>(null);

  const list = useQuery({
    queryKey: ["portfolios"],
    queryFn: () => get<PortfoliosResponse>("/portfolios"),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["portfolios"] });

  const remove = useMutation<unknown, ApiError, number>({
    mutationFn: (id) => del(`/portfolios/${id}`),
    onSuccess: () => {
      invalidate();
      toast.success("Portafoglio eliminato.");
      setPendingDelete(null);
      setDeleteError(null);
    },
    onError: (err) => setDeleteError(err),
  });

  const columns = useMemo<Array<Column<Portfolio>>>(
    () => [
      { key: "name", header: "Nome", render: (p) => p.name },
      { key: "baseCcy", header: "Valuta base", render: (p) => p.baseCcy },
      { key: "broker", header: "Broker", hideOnNarrow: true, render: (p) => p.broker || "—" },
      {
        key: "actions",
        header: "Azioni",
        align: "right",
        render: (p) => (
          <span className="row row--tight">
            <button
              type="button"
              className="btn btn--small"
              onClick={() => setDrawer({ mode: "edit", portfolio: p })}
            >
              Modifica
            </button>
            <button
              type="button"
              className="btn btn--small btn--danger-ghost"
              onClick={() => {
                setDeleteError(null);
                setPendingDelete(p);
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
        <h1>Portafogli</h1>
        <button type="button" className="btn btn--primary" onClick={() => setDrawer({ mode: "create" })}>
          Nuovo portafoglio
        </button>
      </div>

      <DataTable
        caption="Anagrafica dei portafogli"
        columns={columns}
        rows={list.data?.items ?? []}
        rowKey={(p) => p.id}
        loading={list.isPending}
        error={list.error}
        onRetry={() => list.refetch()}
        empty={
          <EmptyState
            title="Nessun portafoglio"
            message="Crea il primo portafoglio per iniziare a registrare i movimenti."
            action={
              <button type="button" className="btn btn--primary" onClick={() => setDrawer({ mode: "create" })}>
                Nuovo portafoglio
              </button>
            }
          />
        }
      />

      <Drawer
        open={Boolean(drawer)}
        title={drawer?.mode === "edit" ? "Modifica portafoglio" : "Nuovo portafoglio"}
        subtitle={drawer?.mode === "edit" ? drawer.portfolio.name : undefined}
        onClose={() => setDrawer(null)}
      >
        {drawer ? (
          <PortfolioForm
            key={drawer.mode === "edit" ? `edit-${drawer.portfolio.id}` : "create"}
            portfolio={drawer.mode === "edit" ? drawer.portfolio : null}
            onSaved={() => {
              toast.success("Portafoglio salvato.");
              setDrawer(null);
            }}
            onCancel={() => setDrawer(null)}
          />
        ) : null}
      </Drawer>

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        title="Eliminare il portafoglio?"
        message={
          deleteError
            ? deleteError.message
            : pendingDelete
              ? `${pendingDelete.name} verrà rimosso dall'anagrafica.`
              : null
        }
        detail={deleteError ? undefined : "Possibile solo se non ha movimenti collegati."}
        confirmLabel={deleteError ? "Riprova a eliminare" : "Elimina"}
        danger
        busy={remove.isPending}
        onConfirm={() => pendingDelete && remove.mutate(pendingDelete.id)}
        onCancel={() => {
          setPendingDelete(null);
          setDeleteError(null);
        }}
      />
    </>
  );
}
