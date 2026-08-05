
interface SpinnerProps {
  label?: string;
  inline?: boolean;
}

export default function Spinner({ label = "Caricamento…", inline = false }: SpinnerProps) {
  return (
    <span className={inline ? "spinner-wrap spinner-wrap--inline" : "spinner-wrap"} role="status">
      <span className="spinner" aria-hidden="true" />
      <span className={inline ? "sr-only" : "spinner-label"}>{label}</span>
    </span>
  );
}
