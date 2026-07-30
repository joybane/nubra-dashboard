import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** Optional label so the message can name the area that failed. */
  label?: string;
}

interface State {
  error: Error | null;
}

/**
 * Catches render-time errors in the React tree and shows a calm, on-brand
 * fallback with a recovery action — instead of a blank screen or the raw
 * runtime-error banner. Live data / WS errors are handled elsewhere; this is
 * the last line of defence for component crashes.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary] render error:', error, info.componentStack);
  }

  private reset = () => this.setState({ error: null });

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div className="flex h-full min-h-[240px] w-full flex-col items-center justify-center gap-4 p-8 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[var(--red-dim)] text-[var(--red)]">
          <svg
            className="h-6 w-6"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"
            />
          </svg>
        </div>
        <div>
          <h2 className="text-[15px] font-semibold text-[var(--text-primary)]">
            {this.props.label ? `${this.props.label} hit an error` : 'Something went wrong'}
          </h2>
          <p className="mt-1 max-w-md text-[13px] text-[var(--text-secondary)]">
            This view crashed unexpectedly. Your data and open positions are safe — you can retry
            this panel or reload the app.
          </p>
          {this.state.error.message && (
            <p className="mt-2 font-mono text-[11px] text-[var(--text-muted)]">
              {this.state.error.message}
            </p>
          )}
        </div>
        <div className="flex gap-2">
          <button
            onClick={this.reset}
            className="rounded-md bg-[var(--accent)] px-4 py-1.5 text-[13px] font-semibold text-white transition-colors hover:bg-[var(--accent-dim)]"
          >
            Try again
          </button>
          <button
            onClick={() => window.location.reload()}
            className="rounded-md border border-[var(--border)] px-4 py-1.5 text-[13px] font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
          >
            Reload app
          </button>
        </div>
      </div>
    );
  }
}
