import EmptyState from "./EmptyState";
import Spinner from "./Spinner";
import type { Key, ReactNode } from "react";

/**
 * Una colonna. Senza `render` la cella mostra `row[key]` così com'è, che è il
 * motivo per cui `key` resta una stringa libera e non un `keyof Row`: le colonne
 * con `render` usano spesso una chiave sintetica ("azioni") che non è un campo.
 */
export interface Column<Row> {
  key: string;
  header: ReactNode;
  align?: "left" | "right";
  render?: (row: Row, index: number) => ReactNode;
  className?: string;
  /** Nascosta sotto i 640px, dove le celle si impilano. */
  hideOnNarrow?: boolean;
}

interface DataTableProps<Row> {
  columns: Array<Column<Row>>;
  rows: Row[] | null | undefined;
  rowKey?: (row: Row, index: number) => Key;
  loading?: boolean;
  /** L'errore da mostrare: se ha un `message` si usa quello. */
  error?: unknown;
  empty?: ReactNode;
  caption?: ReactNode;
  footer?: ReactNode;
  onRetry?: () => void;
}

/**
 * Tabella dati con gli stati espliciti: caricamento, errore, vuoto, popolata.
 *
 * I quattro stati sono qui e non nelle pagine perché sono la parte che si
 * dimentica: una tabella che in errore mostra "nessun dato" fa credere all'utente
 * di non avere movimenti.
 *
 * Generica sulla riga: è ciò che tipizza i `render` delle colonne nel punto in cui
 * vengono scritti, senza che ogni pagina annoti i suoi callback.
 */
export default function DataTable<Row>({
  columns,
  rows,
  rowKey,
  loading = false,
  error = null,
  empty = null,
  caption,
  footer = null,
  onRetry,
}: DataTableProps<Row>) {
  if (loading) {
    return (
      <div className="table-status">
        <Spinner />
      </div>
    );
  }

  if (error) {
    return (
      <div className="card error-card" role="alert">
        <p className="error-title">Impossibile caricare i dati</p>
        <p className="muted">{(error as { message?: string })?.message || String(error)}</p>
        {onRetry ? (
          <button type="button" className="btn" onClick={onRetry}>
            Riprova
          </button>
        ) : null}
      </div>
    );
  }

  if (!rows || rows.length === 0) {
    return empty ?? <EmptyState title="Nessun dato" message="Non c'è nulla da mostrare." />;
  }

  return (
    <div className="table-wrap">
      <table className="table">
        {caption ? <caption className="sr-only">{caption}</caption> : null}
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                scope="col"
                className={[
                  c.align === "right" ? "cell-right" : "",
                  c.hideOnNarrow ? "cell-optional" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={rowKey ? rowKey(row, i) : i}>
              {columns.map((c) => (
                <td
                  key={c.key}
                  className={[
                    c.align === "right" ? "cell-right" : "",
                    c.hideOnNarrow ? "cell-optional" : "",
                    c.className || "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  // L'intestazione ripetuta come data-label è ciò che permette al
                  // CSS di impilare le celle sotto i 640px senza un secondo markup.
                  data-label={typeof c.header === "string" ? c.header : undefined}
                >
                  {/* Senza `render` si mostra il campo omonimo: `key` è una
                      stringa libera, quindi qui l'accesso è per forza dinamico. */}
                  {c.render
                    ? c.render(row, i)
                    : ((row as Record<string, unknown>)[c.key] as ReactNode)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {footer ? <tfoot>{footer}</tfoot> : null}
      </table>
    </div>
  );
}
