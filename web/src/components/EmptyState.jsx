export default function EmptyState({ title, message, action, children }) {
  return (
    <div className="empty">
      {title ? <p className="empty-title">{title}</p> : null}
      {message ? <p className="empty-message">{message}</p> : null}
      {children}
      {action ? <div className="empty-action">{action}</div> : null}
    </div>
  );
}
