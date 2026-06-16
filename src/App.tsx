import { useEffect, useState } from 'react';
import { WsProvider } from './hooks/useWsContext';
import Navbar from './components/Navbar';
import LoginOverlay from './components/LoginOverlay';
import WorkspaceRoot from './workspace/WorkspaceRoot';
import { WorkspaceProvider } from './workspace/WorkspaceProvider';
import { useWorkspaceState } from './workspace/useWorkspaceState';

type AuthStatus = 'unknown' | 'authenticated' | 'unauthenticated';

function AppInner() {
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    return (localStorage.getItem('nubra-theme') as 'dark' | 'light') || 'dark';
  });
  const [auth, setAuth] = useState<AuthStatus>('unknown');

  const { loadInstrumentInActivePane } = useWorkspaceState();

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

  return (
    <div className="h-screen flex flex-col overflow-hidden bg-[var(--bg-primary)] text-[var(--text-primary)]">
      <Navbar
        onInstrumentSelect={loadInstrumentInActivePane}
        theme={theme}
        onThemeToggle={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
      />
      <main className="flex-1 overflow-hidden">
        <WorkspaceRoot theme={theme} />
      </main>
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
        <AppInner />
      </WsProvider>
    </WorkspaceProvider>
  );
}
