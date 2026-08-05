import { Component } from "react";
import type { ReactNode } from "react";

interface ErrorBoundaryProps {
  children?: ReactNode;
}

interface ErrorBoundaryState {
  /** `unknown` perché un throw può essere qualsiasi cosa, non solo un Error. */
  error: unknown;
}

/**
 * Un errore di rendering non deve produrre una pagina bianca: senza log lato
 * client (niente console, e la piattaforma non raccoglie il browser) una pagina
 * bianca è indiagnosticabile. Il messaggio resta a schermo.
 */
export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { error: null };
    this.reset = this.reset.bind(this);
  }

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error };
  }

  reset() {
    this.setState({ error: null });
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="card error-card" role="alert">
        <h2>Qualcosa è andato storto</h2>
        <p>La pagina non è stata disegnata correttamente. Il resto dell'app continua a funzionare.</p>
        <pre className="error-detail">
          {(error as { message?: string })?.message || String(error)}
        </pre>
        <div className="row">
          <button type="button" className="btn" onClick={this.reset}>
            Riprova
          </button>
          <button type="button" className="btn btn--ghost" onClick={() => window.location.reload()}>
            Ricarica la pagina
          </button>
        </div>
      </div>
    );
  }
}
