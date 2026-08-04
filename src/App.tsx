import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import type { Instrument } from './types';
import { WsProvider, useWs } from './hooks/useWsContext';
import { PaperTradingProvider } from './hooks/usePaperTrading';
import { WatchlistProvider } from './hooks/useWatchlistContext';
import { BasketProvider } from './hooks/useBasketContext';
import Navbar from './components/Navbar';
import LoginOverlay from './components/LoginOverlay';
import OrderTerminal from './components/OrderTerminal';
import OrderTicket from './components/OrderTicket';
import WorkspaceRoot from './workspace/WorkspaceRoot';
import ErrorBoundary from './components/ErrorBoundary';
import { WorkspaceProvider } from './workspace/WorkspaceProvider';
import { useWorkspaceState } from './workspace/useWorkspaceState';

// The strategy analysis view is the single largest module and is only shown when
// a saved strategy is opened — load it on demand.
const StrategyAnalysisView = lazy(() => import('./components/StrategyAnalysisView'));

export interface StrategyChartTarget {
  basketGroupId: string;
  strategyName: string;
  snapshotId?: string;
}

type AuthStatus = 'unknown' | 'authenticated' | 'unauthenticated';

function AppInner() {
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    return (localStorage.getItem('nubra-theme') as 'dark' | 'light') || 'dark';
  });
  const [auth, setAuth] = useState<AuthStatus>('unknown');
  const [strategyChart, setStrategyChart] = useState<StrategyChartTarget | null>(null);

  const { loadInstrumentInActivePane } = useWorkspaceState();
  const { subscribe } = useWs();

  const openStrategyChart = useCallback(
    (basketGroupId: string, strategyName: string, snapshotId?: string) => {
      setStrategyChart({ basketGroupId, strategyName, snapshotId });
    },
    [],
  );

  const selectInstrument = useCallback(
    (instrument: Instrument) => {
      loadInstrumentInActivePane(instrument);
    },
    [loadInstrumentInActivePane],
  );

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('nubra-theme', theme);
  }, [theme]);

  useEffect(() => {
    fetch('/auth/status')
      .then((r) => r.json())
      .then((d) => setAuth(d.authenticated ? 'authenticated' : 'unauthenticated'))
      .catch(() => setAuth('unauthenticated'));
  }, []);

  // React to live auth changes — e.g. the broker expiring our session mid-use
  // makes the server broadcast auth_status, which re-shows the login overlay.
  useEffect(() => {
    const unsub = subscribe('auth_status', (msg) => {
      if (msg.type !== 'auth_status') return;
      setAuth(msg.status === 'authenticated' ? 'authenticated' : 'unauthenticated');
    });
    return unsub;
  }, [subscribe]);

  if (auth === 'unknown') {
    return (
      <div className="h-screen bg-[var(--bg-primary)] flex flex-col items-center justify-center gap-3">
        <div className="spinner" />
        <div className="text-[13px] text-[var(--text-muted)]">Connecting…</div>
      </div>
    );
  }

  if (strategyChart) {
    return (
      <div className="h-screen flex flex-col overflow-hidden bg-[var(--bg-primary)] text-[var(--text-primary)]">
        <ErrorBoundary label="Strategy Analysis">
          <Suspense
            fallback={
              <div className="flex flex-1 items-center justify-center">
                <div className="spinner" />
              </div>
            }
          >
            <StrategyAnalysisView
              basketGroupId={strategyChart.basketGroupId}
              strategyName={strategyChart.strategyName}
              snapshotId={strategyChart.snapshotId}
              theme={theme}
              onBack={() => setStrategyChart(null)}
            />
          </Suspense>
        </ErrorBoundary>
        {auth === 'unauthenticated' && (
          <LoginOverlay onAuthenticated={() => setAuth('authenticated')} />
        )}
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col overflow-hidden bg-[var(--bg-primary)] text-[var(--text-primary)]">
      <Navbar
        onInstrumentSelect={selectInstrument}
        theme={theme}
        onThemeToggle={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
      />
      <main className="flex-1 overflow-hidden min-h-0">
        <div className="flex flex-col h-full">
          <div className="flex-1 min-h-0 overflow-hidden">
            <WorkspaceRoot theme={theme} />
          </div>
          <OrderTerminal onOpenStrategyChart={openStrategyChart} />
        </div>
      </main>
      <OrderTicket />
      {auth === 'unauthenticated' && (
        <LoginOverlay onAuthenticated={() => setAuth('authenticated')} />
      )}
    </div>
  );
}

export default function App() {
  return (
    <WorkspaceProvider>
      <WsProvider>
        <PaperTradingProvider>
          <WatchlistProvider>
            <BasketProvider>
              <AppInner />
            </BasketProvider>
          </WatchlistProvider>
        </PaperTradingProvider>
      </WsProvider>
    </WorkspaceProvider>
  );
}
