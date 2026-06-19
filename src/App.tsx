import { useCallback, useEffect, useState } from 'react';
import { WsProvider } from './hooks/useWsContext';
import { PaperTradingProvider } from './hooks/usePaperTrading';
import { WatchlistProvider } from './hooks/useWatchlistContext';
import { BasketProvider } from './hooks/useBasketContext';
import Navbar from './components/Navbar';
import LoginOverlay from './components/LoginOverlay';
import OrderTerminal from './components/OrderTerminal';
import OrderTicket from './components/OrderTicket';
import WorkspaceRoot from './workspace/WorkspaceRoot';
import StrategyAnalysisView from './components/StrategyAnalysisView';
import { WorkspaceProvider } from './workspace/WorkspaceProvider';
import { useWorkspaceState } from './workspace/useWorkspaceState';

export interface StrategyChartTarget {
  basketGroupId: string;
  strategyName: string;
}

type AuthStatus = 'unknown' | 'authenticated' | 'unauthenticated';

function AppInner() {
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    return (localStorage.getItem('nubra-theme') as 'dark' | 'light') || 'dark';
  });
  const [auth, setAuth] = useState<AuthStatus>('unknown');
  const [strategyChart, setStrategyChart] = useState<StrategyChartTarget | null>(null);

  const { loadInstrumentInActivePane } = useWorkspaceState();

  const openStrategyChart = useCallback((basketGroupId: string, strategyName: string) => {
    setStrategyChart({ basketGroupId, strategyName });
  }, []);

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

  if (auth === 'unknown') {
    return (
      <div className="h-screen bg-[var(--bg-primary)] flex items-center justify-center">
        <div className="text-[var(--text-muted)] animate-pulse">Loading...</div>
      </div>
    );
  }

  if (strategyChart) {
    return (
      <div className="h-screen flex flex-col overflow-hidden bg-[var(--bg-primary)] text-[var(--text-primary)]">
        <StrategyAnalysisView
          basketGroupId={strategyChart.basketGroupId}
          strategyName={strategyChart.strategyName}
          theme={theme}
          onBack={() => setStrategyChart(null)}
        />
        {auth === 'unauthenticated' && (
          <LoginOverlay onAuthenticated={() => setAuth('authenticated')} />
        )}
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col overflow-hidden bg-[var(--bg-primary)] text-[var(--text-primary)]">
      <Navbar
        onInstrumentSelect={loadInstrumentInActivePane}
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
