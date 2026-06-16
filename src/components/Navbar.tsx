import { useWs } from '../hooks/useWsContext';
import type { Instrument, Theme } from '../types';
import InstrumentSearch from './InstrumentSearch';

interface NavbarProps {
  onInstrumentSelect: (item: Instrument) => void;
  theme: Theme;
  onThemeToggle: () => void;
}

export default function Navbar({ onInstrumentSelect, theme, onThemeToggle }: NavbarProps) {
  const { wsReady } = useWs();

  return (
    <nav className="h-12 bg-[var(--bg-secondary)] border-b border-[var(--border)] flex items-center px-4 gap-4 shrink-0">
      {/* Brand */}
      <span className="text-[15px] font-bold text-[var(--text-primary)] shrink-0 whitespace-nowrap">
        Stark <span className="text-[var(--accent)]">Venture Capital</span>
      </span>

      {/* Search — takes remaining space */}
      <div className="flex-1 max-w-xs">
        <InstrumentSearch placeholder="Search symbol…" onSelect={onInstrumentSelect} />
      </div>

      {/* WS status dot */}
      <div
        title={`WebSocket: ${wsReady ? 'connected' : 'disconnected'}`}
        className={`w-2 h-2 rounded-full shrink-0 ${wsReady ? 'bg-[var(--green)]' : 'bg-[var(--red)] animate-pulse'}`}
      />

      {/* Theme toggle */}
      <button
        onClick={onThemeToggle}
        title="Toggle theme"
        className="w-8 h-8 rounded-full bg-[var(--bg-card)] border border-[var(--border)] text-[var(--text-secondary)] flex items-center justify-center hover:border-[var(--accent)] hover:text-[var(--text-primary)] transition-all shrink-0"
      >
        {theme === 'dark' ? '☀' : '☾'}
      </button>
    </nav>
  );
}
