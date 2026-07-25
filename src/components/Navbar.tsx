import { useEffect, useState, useRef } from 'react';
import { useWs } from '../hooks/useWsContext';
import type { Instrument, Theme, LayoutType } from '../types';
import InstrumentSearch from './InstrumentSearch';
import ConfirmDialog from './ConfirmDialog';
import { logger } from '../lib/logger';
import { useWorkspaceState } from '../workspace/useWorkspaceState';
import { VIEW_LABELS, VIEW_ORDER, LAYOUT_OPTIONS } from '../workspace/viewConfig';

interface NavbarProps {
  onInstrumentSelect: (item: Instrument) => void;
  theme: Theme;
  onThemeToggle: () => void;
}

function renderLayoutIcon(type: LayoutType, active = false) {
  const bgClass = active ? 'bg-[var(--accent)]' : 'bg-current opacity-40 group-hover:opacity-80 transition-opacity';
  switch (type) {
    case 'single':
      return (
        <div className="w-5 h-5 border border-current rounded flex items-center justify-center p-0.5">
          <div className={`w-full h-full rounded-sm ${bgClass}`} />
        </div>
      );
    case 'hsplit':
      return (
        <div className="w-5 h-5 border border-current rounded flex gap-0.5 p-0.5">
          <div className={`flex-1 h-full rounded-sm ${bgClass}`} />
          <div className={`flex-1 h-full rounded-sm ${bgClass}`} />
        </div>
      );
    case 'vsplit':
      return (
        <div className="w-5 h-5 border border-current rounded flex flex-col gap-0.5 p-0.5">
          <div className={`flex-1 w-full rounded-sm ${bgClass}`} />
          <div className={`flex-1 w-full rounded-sm ${bgClass}`} />
        </div>
      );
    case 'grid':
      return (
        <div className="w-5 h-5 border border-current rounded grid grid-cols-2 gap-0.5 p-0.5">
          <div className={`rounded-sm ${bgClass}`} />
          <div className={`rounded-sm ${bgClass}`} />
          <div className={`rounded-sm ${bgClass}`} />
          <div className={`rounded-sm ${bgClass}`} />
        </div>
      );
    case 'tleft':
      return (
        <div className="w-5 h-5 border border-current rounded flex gap-0.5 p-0.5">
          <div className={`w-[45%] h-full rounded-sm ${bgClass}`} />
          <div className="flex-1 h-full flex flex-col gap-0.5">
            <div className={`flex-1 rounded-sm ${bgClass}`} />
            <div className={`flex-1 rounded-sm ${bgClass}`} />
          </div>
        </div>
      );
    case 'tright':
      return (
        <div className="w-5 h-5 border border-current rounded flex gap-0.5 p-0.5">
          <div className="flex-1 h-full flex flex-col gap-0.5">
            <div className={`flex-1 rounded-sm ${bgClass}`} />
            <div className={`flex-1 rounded-sm ${bgClass}`} />
          </div>
          <div className={`w-[45%] h-full rounded-sm ${bgClass}`} />
        </div>
      );
  }
}

export default function Navbar({ onInstrumentSelect, theme, onThemeToggle }: NavbarProps) {
  const { wsReady } = useWs();
  const { state, setPaneView, setLayout } = useWorkspaceState();
  const { layout, panes, activePane } = state;

  const [layoutOpen, setLayoutOpen] = useState(false);
  const [logoutOpen, setLogoutOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const doLogout = async () => {
    setLoggingOut(true);
    try {
      const res = await fetch('/auth/logout', { method: 'POST' });
      if (res.ok) window.location.reload();
      else setLoggingOut(false);
    } catch (e) {
      logger.error('Logout failed:', e);
      setLoggingOut(false);
    }
  };

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setLayoutOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const currentActivePaneId = activePane || panes[0]?.id;
  const activePaneState = panes.find((p) => p.id === currentActivePaneId);
  const currentView = activePaneState?.view || 'chart';

  return (
    <nav className="h-12 bg-[var(--bg-secondary)] border-b border-[var(--border)] flex items-center px-4 gap-4 shrink-0 justify-between">
      <div className="flex items-center gap-4 min-w-0 flex-1">
        {/* Brand */}
        <span className="text-[15px] font-bold text-[var(--text-primary)] shrink-0 whitespace-nowrap">
          bRODHa
        </span>

        {/* Search */}
        <div className="w-[280px] shrink-0">
          <InstrumentSearch placeholder="Search symbol…" onSelect={onInstrumentSelect} />
        </div>

        {/* View selector tabs */}
        <div className="flex items-center gap-1 overflow-x-auto min-w-0 py-1">
          {VIEW_ORDER.map((v) => (
            <button
              key={v}
              onClick={() => {
                if (currentActivePaneId) {
                  setPaneView(currentActivePaneId, v);
                }
              }}
              className={`px-2.5 py-1 rounded text-[11px] font-medium whitespace-nowrap transition-all ${
                currentView === v
                  ? 'bg-[var(--accent)] text-white'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
              }`}
            >
              {VIEW_LABELS[v]}
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-3 shrink-0">
        {/* WS status dot */}
        <div
          title={`WebSocket: ${wsReady ? 'connected' : 'disconnected'}`}
          className={`w-2 h-2 rounded-full ${wsReady ? 'bg-[var(--green)]' : 'bg-[var(--red)] animate-pulse'}`}
        />

        {/* Custom Layout Picker Dropdown */}
        <div className="relative" ref={dropdownRef}>
          <button
            onClick={() => setLayoutOpen(!layoutOpen)}
            className="w-8 h-8 rounded-full bg-[var(--bg-card)] border border-[var(--border)] text-[var(--text-secondary)] flex items-center justify-center hover:border-[var(--accent)] hover:text-[var(--text-primary)] transition-all cursor-pointer"
            title="Choose layout"
            aria-label="Choose workspace layout"
            aria-haspopup="menu"
            aria-expanded={layoutOpen}
          >
            {renderLayoutIcon(layout as LayoutType, true)}
          </button>
          
          {layoutOpen && (
            <div className="absolute right-0 mt-2 bg-[var(--bg-card)] border border-[var(--border)] rounded-lg shadow-xl p-3 z-[9999] min-w-[210px] flex flex-col gap-2">
              <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] font-bold px-1 border-b border-[var(--border)] pb-1.5 mb-1">
                Select Layout
              </div>
              <div className="grid grid-cols-3 gap-2">
                {LAYOUT_OPTIONS.map((opt) => (
                  <button
                    key={opt.id}
                    onClick={() => {
                      setLayout(opt.id);
                      setLayoutOpen(false);
                    }}
                    title={opt.label}
                    className={`group p-2 rounded-md border flex flex-col items-center justify-center gap-1.5 transition-all cursor-pointer ${
                      layout === opt.id
                        ? 'border-[var(--accent)] bg-[var(--bg-hover)] text-[var(--accent)]'
                        : 'border-[var(--border)] hover:border-[var(--text-muted)] text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                    }`}
                  >
                    {renderLayoutIcon(opt.id, layout === opt.id)}
                    <span className="text-[9px] font-medium text-center truncate w-full">
                      {opt.short}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Theme toggle */}
        <button
          onClick={onThemeToggle}
          title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          className="w-8 h-8 rounded-full bg-[var(--bg-card)] border border-[var(--border)] text-[var(--text-secondary)] flex items-center justify-center hover:border-[var(--accent)] hover:text-[var(--text-primary)] transition-all cursor-pointer"
        >
          {theme === 'dark' ? (
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="4" />
              <path strokeLinecap="round" d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32l1.41 1.41M2 12h2m16 0h2M4.93 19.07l1.41-1.41m11.32-11.32l1.41-1.41" />
            </svg>
          ) : (
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" />
            </svg>
          )}
        </button>

        {/* Logout */}
        <button
          onClick={() => setLogoutOpen(true)}
          title="Logout"
          aria-label="Log out"
          className="w-8 h-8 rounded-full bg-[var(--bg-card)] border border-[var(--border)] text-red-400 hover:text-red-500 hover:border-red-500/50 flex items-center justify-center transition-all cursor-pointer"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15M12 9l-3 3m0 0l3 3m-3-3h12.75" />
          </svg>
        </button>
      </div>

      <ConfirmDialog
        open={logoutOpen}
        title="Log out?"
        message="You'll need to sign in again with OTP and MPIN to resume trading."
        confirmLabel="Log out"
        danger
        busy={loggingOut}
        onConfirm={doLogout}
        onCancel={() => setLogoutOpen(false)}
      />
    </nav>
  );
}
