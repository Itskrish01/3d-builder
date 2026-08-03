import { Component } from 'react';

/* A blank screen tells nobody anything. If the chrome throws, say what broke
   and leave the world on screen behind it — the canvas is the engine's, and
   the engine is almost certainly still running. */
export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('Grass Painter UI crashed:', error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="fatal">
        <div className="in">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 9v4M12 17h.01" />
            <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
          </svg>
          <h2>The controls stopped responding</h2>
          <p>
            Your world is safe — it is saved in this browser and will come back when you reload.
            <br /><br />
            <code>{String(this.state.error?.message || this.state.error)}</code>
          </p>
          <div className="btn-row" style={{ justifyContent: 'center' }}>
            <button type="button" className="btn pri" onClick={() => window.location.reload()}>Reload</button>
          </div>
        </div>
      </div>
    );
  }
}
