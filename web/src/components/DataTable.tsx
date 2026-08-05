import EmptyState from "./EmptyState";
import Spinner from "./Spinner";
import type { ReactNode } from "react";
import type { PositionRow } from "../types";

interface DataTableProps {
  columns?: any;
  rows: PositionRow[];
  rowKey?: any;
  loading?: boolean;
  error?: ReactNode;
  empty?: any;
  caption?: any;
  footer?: any;
  onRetry?: (...args: any[]) => void;
}


/**
 * Tabella dati con gli stati espliciti: caricamento, errore, vuoto, popolata.
 *
 * I quattro stati sono qui e non nelle pagine perché sono la parte che si
 * dimentica: una tabella che in errore mostra "nessun dato" fa credere all'utente
 * di non avere movimenti.
 *
 * @param {Array<{key, header, align?, render?, className?, hideOnNarrow?}>} columns
 */
export default function DataTable({
  columns,
  rows,
  rowKey,
  loading = false,
  error = null,
  empty = null,
  caption,
  footer = null,
  onRetry,
}: DataTableProps) {
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
        <p className="muted">{error.message || String(error)}</p>
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
                  {c.render ? c.render(row, i) : row[c.key]}
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
