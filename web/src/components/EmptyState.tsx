import type { ReactNode } from "react";

interface EmptyStateProps {
  /** Opzionale: chi ha già un <h1> sopra passa solo il messaggio. */
  title?: ReactNode;
  message?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
}

export default function EmptyState({ title, message, action, children }: EmptyStateProps) {
  return (
    <div className="empty">
      {title ? <p className="empty-title">{title}</p> : null}
      {message ? <p className="empty-message">{message}</p> : null}
      {children}
      {action ? <div className="empty-action">{action}</div> : null}
    </div>
  );
}
