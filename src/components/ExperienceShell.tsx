import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import Navbar from './Navbar';
import { useDensity } from '../hooks/useDensity';
import { useMenuKeyboard } from '../hooks/useMenuKeyboard';
import type { Instrument, Theme, ViewType } from '../types';
import { useWs } from '../hooks/useWsContext';
import { useWorkspaceState } from '../workspace/useWorkspaceState';
import { LAYOUT_OPTIONS, VIEW_LABELS, VIEW_ORDER } from '../workspace/viewConfig';
import BrandMark from './BrandMark';
import ConfirmDialog from './ConfirmDialog';
import InstrumentSearch from './InstrumentSearch';
import UiIcon from './UiIcon';
import { EXPERIENCE_OPTIONS } from '../lib/experience';

interface ExperienceShellProps {
  children: ReactNode;
  onInstrumentSelect: (instrument: Instrument) => void;
  onThemeChange: (theme: Theme) => void;
  theme: Theme;
}

function ExperiencePicker({ theme, onChange }: { theme: Theme; onChange: (theme: Theme) => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useMenuKeyboard(root, open, () => setOpen(false));
  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);
  return (
    <div className="experience-picker" ref={root}>
      <button
        className="experience-icon-button"
        aria-label={`Change experience. Current: ${theme}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <UiIcon name={theme === 'apex' ? 'sun' : 'moon'} size={17} />
      </button>
      {open && (
        <div className="experience-menu" role="menu" aria-label="Frontend experience">
          <span className="experience-menu-label">Experience</span>
          {EXPERIENCE_OPTIONS.map((option) => (
            <button
              key={option.id}
              role="menuitemradio"
              aria-checked={theme === option.id}
              className={theme === option.id ? 'is-active' : ''}
              onClick={() => {
                onChange(option.id);
                setOpen(false);
              }}
            >
              <span className={`theme-swatch theme-swatch-${option.id}`} aria-hidden="true" />
              <span>
                <strong>{option.label}</strong>
                <small>{option.detail}</small>
              </span>
              {theme === option.id && <em aria-hidden="true">✓</em>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function LayoutPicker() {
  const { state, setLayout } = useWorkspaceState();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useMenuKeyboard(root, open, () => setOpen(false));
  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);
  return (
    <div className="experience-layout-picker" ref={root}>
      <button
        className="experience-icon-button"
        aria-label="Choose pane layout"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <UiIcon name="layout" size={17} />
      </button>
      {open && (
        <div className="experience-layout-menu" role="menu">
          <span className="experience-menu-label">Pane arrangement</span>
          <div>
            {LAYOUT_OPTIONS.map((layout) => (
              <button
                key={layout.id}
                role="menuitemradio"
                aria-checked={state.layout === layout.id}
                className={state.layout === layout.id ? 'is-active' : ''}
                onClick={() => {
                  setLayout(layout.id);
                  setOpen(false);
                }}
              >
                <span className={`layout-glyph layout-${layout.id}`} aria-hidden="true" />
                <span>{layout.short}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function CommandPalette({
  open,
  onOpenChange,
  onThemeChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onThemeChange: (theme: Theme) => void;
}) {
  const { state, setLayout, setPaneView } = useWorkspaceState();
  const paneId = state.activePane || state.panes[0]?.id;
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const commands = useMemo(
    () => [
      ...VIEW_ORDER.map((view) => ({
        id: `view-${view}`,
        label: `Open ${VIEW_LABELS[view]}`,
        detail: 'Open in the active pane',
        run: () => paneId && setPaneView(paneId, view),
      })),
      ...LAYOUT_OPTIONS.map((layout) => ({
        id: `layout-${layout.id}`,
        label: layout.label,
        detail: 'Change pane arrangement',
        run: () => setLayout(layout.id),
      })),
      ...EXPERIENCE_OPTIONS.map((option) => ({
        id: `experience-${option.id}`,
        label: `Use ${option.label}`,
        detail: option.detail,
        run: () => onThemeChange(option.id),
      })),
    ],
    [onThemeChange, paneId, setLayout, setPaneView],
  );
  const results = commands.filter((command) =>
    `${command.label} ${command.detail}`.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const activeIndex = Math.min(selected, Math.max(0, results.length - 1));
  const run = useCallback(
    (index: number) => {
      results[index]?.run();
      if (results[index]) onOpenChange(false);
    },
    [onOpenChange, results],
  );
  useEffect(() => {
    if (!open) {
      setQuery('');
      setSelected(0);
    }
  }, [open]);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="command-overlay experience-command-overlay" />
        <Dialog.Content
          className="command-dialog experience-command-dialog"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            input.current?.focus();
          }}
        >
          <Dialog.Title className="sr-only">Workspace commands</Dialog.Title>
          <Dialog.Description className="sr-only">
            Search views, layouts, and frontend experiences.
          </Dialog.Description>
          <div className="command-input-row">
            <UiIcon name="command" size={19} />
            <input
              ref={input}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setSelected(0);
              }}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault();
                  setSelected(
                    (activeIndex + (event.key === 'ArrowDown' ? 1 : -1) + results.length) %
                      (results.length || 1),
                  );
                }
                if (event.key === 'Enter') run(activeIndex);
              }}
              placeholder="Search commands, views, layouts…"
              role="combobox"
              aria-expanded="true"
              aria-controls="experience-command-results"
              aria-label="Search workspace commands"
              aria-activedescendant={
                results[activeIndex] ? `command-${results[activeIndex].id}` : undefined
              }
            />
            <Dialog.Close className="experience-icon-button" aria-label="Close commands">
              <UiIcon name="close" size={17} />
            </Dialog.Close>
          </div>
          <div id="experience-command-results" className="command-results" role="listbox">
            {!results.length && <div className="command-empty">No matching commands</div>}
            {results.map((command, index) => (
              <button
                key={command.id}
                id={`command-${command.id}`}
                role="option"
                aria-selected={index === activeIndex}
                className={`command-result ${index === activeIndex ? 'is-active' : ''}`}
                onMouseMove={() => setSelected(index)}
                onClick={() => run(index)}
              >
                <span>
                  <strong>{command.label}</strong>
                  <small>{command.detail}</small>
                </span>
                <kbd>↵</kbd>
              </button>
            ))}
          </div>
          <div className="command-footer">
            <span>↑↓ Navigate · Enter Open</span>
            <span>Esc Close</span>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export default function ExperienceShell({
  children,
  onInstrumentSelect,
  onThemeChange,
  theme,
}: ExperienceShellProps) {
  const { wsReady } = useWs();
  const { state, setPaneView } = useWorkspaceState();
  const paneId = state.activePane || state.panes[0]?.id;
  const pane = state.panes.find((item) => item.id === paneId) || state.panes[0];
  const instrument = pane?.instrument;
  const { density, toggleDensity } = useDensity();
  const [commandsOpen, setCommandsOpen] = useState(false);
  const [logoutOpen, setLogoutOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState('');
  const [inspectorOpen, setInspectorOpen] = useState(
    () => localStorage.getItem('nubra-inspector') === 'open',
  );
  useEffect(() => {
    localStorage.setItem('nubra-inspector', inspectorOpen ? 'open' : 'closed');
  }, [inspectorOpen]);
  const searchHost = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (theme !== 'bloomberg' && theme !== 'apex') return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.closest('[role="dialog"]')) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setCommandsOpen(true);
        return;
      }
      if (target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]'))
        return;
      if (event.altKey && !event.ctrlKey && !event.metaKey && /^[1-9]$/.test(event.key)) {
        event.preventDefault();
        if (paneId) setPaneView(paneId, VIEW_ORDER[Number(event.key) - 1]);
      } else if (event.key === '?') {
        event.preventDefault();
        setCommandsOpen(true);
      } else if (event.key === '/') {
        event.preventDefault();
        searchHost.current?.querySelector('input')?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [theme, paneId, setPaneView]);

  async function logout() {
    setLoggingOut(true);
    setLogoutError('');
    try {
      const response = await fetch('/auth/logout', { method: 'POST' });
      if (!response.ok) throw new Error('Logout failed');
      window.location.reload();
    } catch {
      setLogoutError('Could not log out. Please try again.');
      setLoggingOut(false);
    }
  }

  const openView = (view: ViewType) => paneId && setPaneView(paneId, view);
  const instrumentName = instrument?.nubra_name || instrument?.stock_name || 'NIFTY';

  const classic = theme !== 'apex' && theme !== 'bloomberg';
  const terminal = theme === 'bloomberg';

  // Keep the workspace at one stable React position across every experience.
  // Only chrome changes: chart controls, drafts and terminal state must survive.

  return (
    <div
      className={`experience-frame ${classic ? 'classic-experience' : terminal ? 'bloomberg-experience' : 'apex-experience'}`}
    >
      {classic ? (
        <Navbar
          theme={theme}
          onThemeChange={onThemeChange}
          onInstrumentSelect={onInstrumentSelect}
        />
      ) : terminal ? (
        <>
          <header className="bb-command-deck">
            <BrandMark product="TERMINAL" />
            <span className="bb-command-code">CMD</span>
            <div ref={searchHost} className="bb-search">
              <InstrumentSearch placeholder="Search securities…" onSelect={onInstrumentSelect} />
              <kbd>/</kbd>
            </div>
            <nav className="bb-functions" aria-label="Terminal functions">
              {VIEW_ORDER.map((view, index) => (
                <button
                  key={view}
                  className={pane?.view === view ? 'is-active' : ''}
                  aria-current={pane?.view === view ? 'page' : undefined}
                  title={`${VIEW_LABELS[view]} · Alt+${index + 1}`}
                  onClick={() => openView(view)}
                >
                  <small>{index + 1}</small>
                  <span>{VIEW_LABELS[view]}</span>
                </button>
              ))}
            </nav>
            <div className="bb-deck-actions">
              <span className={`bb-feed ${wsReady ? 'is-live' : ''}`}>
                {wsReady ? 'WS ON' : 'WS RETRY'}
              </span>
              <button
                className="experience-icon-button"
                onClick={toggleDensity}
                aria-label={`Toggle density. Current: ${density}`}
                title={`Density: ${density}`}
              >
                <UiIcon name="density" size={17} />
              </button>
              <LayoutPicker />
              <button
                className="experience-icon-button"
                onClick={() => setCommandsOpen(true)}
                aria-label="Commands"
              >
                <UiIcon name="command" size={17} />
              </button>
              <ExperiencePicker theme={theme} onChange={onThemeChange} />
              <button
                className="experience-icon-button"
                onClick={() => setLogoutOpen(true)}
                aria-label="Log out"
              >
                <UiIcon name="logout" size={17} />
              </button>
            </div>
          </header>
          <div className="bb-status-line">
            <span>SIMULATION ENVIRONMENT</span>
            <strong>{instrumentName}</strong>
            <span>{instrument?.exchange || 'NSE'}</span>
            <span>{VIEW_LABELS[pane?.view || 'chart']}</span>
            <em>{wsReady ? 'MARKET DATA CONNECTED' : 'RECONNECTING TO MARKET DATA'}</em>
            <time>
              {new Date().toLocaleDateString('en-IN', {
                day: '2-digit',
                month: 'short',
                year: 'numeric',
              })}
            </time>
          </div>
        </>
      ) : (
        <header className="apex-global-bar">
          <BrandMark product="APEX" />
          <div ref={searchHost} className="apex-omnibox">
            <InstrumentSearch placeholder="Search instruments…" onSelect={onInstrumentSelect} />
            <kbd>/</kbd>
          </div>
          <div className="apex-market-state">
            <span className={wsReady ? 'is-live' : ''} />
            <div>
              <small>Market data</small>
              <strong>{wsReady ? 'Connected' : 'Reconnecting'}</strong>
            </div>
          </div>
          <span className="apex-sim-badge">SIMULATED</span>
          <button
            className="experience-icon-button"
            onClick={() => setCommandsOpen(true)}
            aria-label="Open command center"
          >
            <UiIcon name="command" size={17} />
          </button>
          <LayoutPicker />
          <button
            className={`experience-icon-button ${inspectorOpen ? 'is-active' : ''}`}
            onClick={() => setInspectorOpen((value) => !value)}
            aria-label="Toggle workspace inspector"
            aria-pressed={inspectorOpen}
          >
            <UiIcon name="monitor" size={17} />
          </button>
          <ExperiencePicker theme={theme} onChange={onThemeChange} />
          <button
            className="experience-icon-button"
            onClick={() => setLogoutOpen(true)}
            aria-label="Log out"
          >
            <UiIcon name="logout" size={17} />
          </button>
        </header>
      )}
      <div className="experience-body">
        {!classic && !terminal && (
          <aside className="apex-rail" aria-label="Product areas">
            <span className="apex-rail-caption">Workspace</span>
            {VIEW_ORDER.map((view) => (
              <button
                key={view}
                className={pane?.view === view ? 'is-active' : ''}
                onClick={() => openView(view)}
              >
                <UiIcon
                  name={
                    view === 'chart' || view === 'optionchain'
                      ? 'trade'
                      : view === 'basket' || view === 'backtest'
                        ? 'strategy'
                        : view === 'nubrabacktest' ||
                            view === 'analysis' ||
                            view === 'signalbacktest'
                          ? 'research'
                          : 'monitor'
                  }
                  size={18}
                />
                <span>{VIEW_LABELS[view]}</span>
              </button>
            ))}
            <span className="apex-rail-spacer" />
            <button onClick={toggleDensity} title={`Density: ${density}`}>
              <UiIcon name="density" size={18} />
              <span>{density === 'compact' ? 'Compact' : 'Comfort'}</span>
            </button>
          </aside>
        )}
        <section className="experience-stage">
          {!classic && !terminal && (
            <div className="apex-context-bar">
              <div>
                <small>Active instrument</small>
                <strong>{instrumentName}</strong>
                <span>{instrument?.exchange || 'NSE'}</span>
              </div>
              <span className="apex-context-divider" />
              <div>
                <small>Workspace</small>
                <strong>{VIEW_LABELS[pane?.view || 'chart']}</strong>
                <span>{state.layout.replace('split', ' split')}</span>
              </div>
              <span className="apex-context-spacer" />
              <span className={wsReady ? 'apex-status-positive' : 'apex-status-warning'}>
                {wsReady ? 'Stream connected' : 'Prices may be delayed'}
              </span>
            </div>
          )}
          <div className="experience-content">{children}</div>
        </section>
        {!classic && !terminal && inspectorOpen && (
          <aside className="apex-inspector" aria-label="Workspace inspector">
            <div className="apex-inspector-heading">
              <span>
                <small>Workspace inspector</small>
                <strong>{instrumentName}</strong>
              </span>
              <button onClick={() => setInspectorOpen(false)} aria-label="Close inspector">
                <UiIcon name="close" size={15} />
              </button>
            </div>
            <div className="apex-inspector-card">
              <small>Instrument context</small>
              <dl>
                <div>
                  <dt>Exchange</dt>
                  <dd>{instrument?.exchange || 'NSE'}</dd>
                </div>
                <div>
                  <dt>Type</dt>
                  <dd>{instrument?.derivative_type || 'INDEX'}</dd>
                </div>
                <div>
                  <dt>Lot size</dt>
                  <dd>{instrument?.lot_size || '—'}</dd>
                </div>
              </dl>
            </div>
            <div className="apex-inspector-card">
              <small>Open in active pane</small>
              <div className="apex-inspector-actions">
                <button onClick={() => openView('chart')}>Chart</button>
                <button onClick={() => openView('optionchain')}>Option chain</button>
                <button onClick={() => openView('basket')}>Build strategy</button>
              </div>
            </div>
            <div className="apex-inspector-note">
              <UiIcon name="command" size={16} />
              <span>
                <kbd>Ctrl K</kbd> opens the command center from anywhere.
              </span>
            </div>
          </aside>
        )}
      </div>
      <CommandPalette
        open={commandsOpen}
        onOpenChange={setCommandsOpen}
        onThemeChange={onThemeChange}
      />
      <ConfirmDialog
        open={logoutOpen}
        title="Log out?"
        message={logoutError || "You'll need to sign in again with OTP and MPIN."}
        confirmLabel="Log out"
        danger
        busy={loggingOut}
        onConfirm={logout}
        onCancel={() => setLogoutOpen(false)}
      />
    </div>
  );
}
