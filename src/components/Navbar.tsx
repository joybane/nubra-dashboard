import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useWs } from '../hooks/useWsContext';
import type { Instrument, LayoutType, ShellLayout, Theme } from '../types';
import InstrumentSearch from './InstrumentSearch';
import ConfirmDialog from './ConfirmDialog';
import UiIcon from './UiIcon';
import { useWorkspaceState } from '../workspace/useWorkspaceState';
import { VIEW_LABELS, VIEW_ORDER, LAYOUT_OPTIONS } from '../workspace/viewConfig';

interface NavbarProps {
  onInstrumentSelect: (item: Instrument) => void;
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
  shellLayout: ShellLayout;
  onShellLayoutChange: (layout: ShellLayout) => void;
}

function LayoutIcon({ type, active = false }: { type: LayoutType; active?: boolean }) {
  const cell = active ? 'bg-[var(--accent)]' : 'bg-current opacity-40';
  const frame = 'w-5 h-5 border border-current rounded p-0.5';
  if (type === 'single') return <div className={frame}><div className={`w-full h-full rounded-sm ${cell}`} /></div>;
  if (type === 'hsplit') return <div className={`${frame} flex gap-0.5`}><div className={`flex-1 ${cell}`} /><div className={`flex-1 ${cell}`} /></div>;
  if (type === 'vsplit') return <div className={`${frame} flex flex-col gap-0.5`}><div className={`flex-1 ${cell}`} /><div className={`flex-1 ${cell}`} /></div>;
  if (type === 'grid') return <div className={`${frame} grid grid-cols-2 gap-0.5`}>{[0, 1, 2, 3].map((n) => <div key={n} className={cell} />)}</div>;
  const tallFirst = type === 'tleft';
  return <div className={`${frame} flex gap-0.5`}>
    {tallFirst && <div className={`w-[45%] ${cell}`} />}
    <div className="flex-1 flex flex-col gap-0.5"><div className={`flex-1 ${cell}`} /><div className={`flex-1 ${cell}`} /></div>
    {!tallFirst && <div className={`w-[45%] ${cell}`} />}
  </div>;
}

const THEME_OPTIONS: { id: Theme; label: string; detail: string }[] = [
  { id: 'dark', label: 'Dark', detail: 'Modern low-light palette' },
  { id: 'light', label: 'Light', detail: 'Bright daytime palette' },
  { id: 'bloomberg', label: 'Bloomberg', detail: 'Dense black & amber terminal' },
  { id: 'graphite', label: 'Graphite', detail: 'Neutral black charting workspace' },
];

export default function Navbar({ onInstrumentSelect, theme, onThemeChange, shellLayout, onShellLayoutChange }: NavbarProps) {
  const { wsReady } = useWs();
  const { state, setPaneView, setLayout } = useWorkspaceState();
  const paneId = state.activePane || state.panes[0]?.id;
  const pane = state.panes.find((p) => p.id === paneId) || state.panes[0];
  const [density, setDensity] = useState(() => localStorage.getItem('nubra-density') === 'comfortable' ? 'comfortable' : 'compact');
  const [layoutOpen, setLayoutOpen] = useState(false);
  const [themeOpen, setThemeOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const [logoutOpen, setLogoutOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState('');
  const searchRef = useRef<HTMLDivElement>(null);
  const layoutRef = useRef<HTMLDivElement>(null);
  const themeRef = useRef<HTMLDivElement>(null);
  const focusSearchAfterClose = useRef(false);
  const commandInput = useRef<HTMLInputElement>(null);
  const toggleDensity = useCallback(() => setDensity((value) => value === 'compact' ? 'comfortable' : 'compact'), []);

  useEffect(() => {
    document.documentElement.dataset.density = density;
    localStorage.setItem('nubra-density', density);
  }, [density]);

  useEffect(() => {
    const closeLayout = (event: MouseEvent) => {
      if (!layoutRef.current?.contains(event.target as Node)) setLayoutOpen(false);
      if (!themeRef.current?.contains(event.target as Node)) setThemeOpen(false);
    };
    document.addEventListener('mousedown', closeLayout);
    return () => document.removeEventListener('mousedown', closeLayout);
  }, []);

  useEffect(() => {
    const openCommands = () => { setQuery(''); setSelected(0); setPaletteOpen(true); };
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault(); openCommands(); return;
      }
      const target = event.target as HTMLElement;
      if (target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return;
      if (event.key === '/') {
        event.preventDefault(); searchRef.current?.querySelector('input')?.focus();
      } else if (event.key === '?') {
        event.preventDefault(); openCommands();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const commands = useMemo(() => [
    { id: 'search', label: 'Search instruments', detail: 'Find a symbol in the active pane', key: '/', run: () => { focusSearchAfterClose.current = true; } },
    ...VIEW_ORDER.map((view) => ({ id: view, label: `Open ${VIEW_LABELS[view]}`, detail: 'Navigate in the active pane', key: '', run: () => paneId && setPaneView(paneId, view) })),
    ...LAYOUT_OPTIONS.map((layout) => ({ id: layout.id, label: layout.label, detail: 'Change workspace layout', key: '', run: () => setLayout(layout.id) })),
    { id: 'shell-classic', label: 'Use classic navigation', detail: 'All views in the top navigation', key: '', run: () => onShellLayoutChange('classic') },
    { id: 'shell-workspace', label: 'Use workspace navigation', detail: 'Grouped views with the left rail', key: '', run: () => onShellLayoutChange('workspace') },
    ...THEME_OPTIONS.map((option) => ({ id: `theme-${option.id}`, label: `Use ${option.label} theme`, detail: option.detail, key: '', run: () => onThemeChange(option.id) })),
    { id: 'density', label: `Use ${density === 'compact' ? 'comfortable' : 'compact'} density`, detail: 'Appearance', key: '', run: toggleDensity },
  ], [paneId, setPaneView, setLayout, onThemeChange, onShellLayoutChange, density, toggleDensity]);
  const filtered = commands.filter((command) => `${command.label} ${command.detail}`.toLowerCase().includes(query.toLowerCase().trim()));
  const activeIndex = Math.min(selected, Math.max(0, filtered.length - 1));
  const runCommand = (index: number) => {
    const command = filtered[index];
    if (!command) return;
    command.run();
    setPaletteOpen(false);
  };

  useEffect(() => {
    if (paletteOpen) document.getElementById(`command-${activeIndex}`)?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, paletteOpen, query]);

  async function doLogout() {
    setLoggingOut(true); setLogoutError('');
    try {
      const response = await fetch('/auth/logout', { method: 'POST' });
      if (!response.ok) throw new Error('Logout failed');
      window.location.reload();
    } catch {
      setLogoutError('Could not log out. Please try again.');
      setLoggingOut(false);
    }
  }

  return <>
    <nav className={`classic-navbar ${shellLayout === 'workspace' ? 'is-workspace-shell' : ''}`}>
      <span className="classic-brand">bRODHa</span>
      <div ref={searchRef} className="classic-search"><InstrumentSearch placeholder="Search symbol…" onSelect={onInstrumentSelect} /><kbd className="search-key">/</kbd></div>
      <div className="classic-view-tabs" aria-label="Workspace views">
        {VIEW_ORDER.map((view) => <button key={view} aria-current={pane?.view === view ? 'page' : undefined}
          className={`classic-view-tab ${pane?.view === view ? 'is-active' : ''}`}
          onClick={() => paneId && setPaneView(paneId, view)}>{VIEW_LABELS[view]}</button>)}
      </div>
      <div className="classic-actions">
        <span className={`connection-dot ${wsReady ? '' : 'is-offline'}`} role="status" title={wsReady ? 'Connected' : 'Reconnecting; prices may be delayed'} />
        <span className="mode-badge" title="Orders are simulated">SIM</span>
        <button className="shell-icon-button command-trigger" onClick={() => { setQuery(''); setSelected(0); setPaletteOpen(true); }} title="Commands & shortcuts (Ctrl+K)" aria-label="Commands & shortcuts"><UiIcon name="command" /></button>
        <div className="relative" ref={layoutRef}>
          <button className="shell-icon-button" aria-label="Choose workspace layout" aria-haspopup="menu" aria-expanded={layoutOpen} title="Choose layout" onClick={() => setLayoutOpen((open) => !open)}><LayoutIcon type={state.layout} active /></button>
          {layoutOpen && <div className="classic-layout-menu" role="menu">
            <div className="menu-label">Navigation</div>
            <div className="shell-layout-choices">
              <button role="menuitemradio" aria-checked={shellLayout === 'classic'} className={`shell-layout-choice ${shellLayout === 'classic' ? 'is-active' : ''}`} onClick={() => { onShellLayoutChange('classic'); setLayoutOpen(false); }}><span className="shell-layout-preview preview-classic" /><span><strong>Classic</strong><small>Top navigation</small></span></button>
              <button role="menuitemradio" aria-checked={shellLayout === 'workspace'} className={`shell-layout-choice ${shellLayout === 'workspace' ? 'is-active' : ''}`} onClick={() => { onShellLayoutChange('workspace'); setLayoutOpen(false); }}><span className="shell-layout-preview preview-workspace" /><span><strong>Workspace</strong><small>Left rail</small></span></button>
            </div>
            <div className="menu-label">Pane arrangement</div>
            <div className="grid grid-cols-3 gap-2">{LAYOUT_OPTIONS.map((layout) => <button key={layout.id} role="menuitemradio" aria-checked={state.layout === layout.id} title={layout.label} className={`classic-layout-option ${state.layout === layout.id ? 'is-active' : ''}`} onClick={() => { setLayout(layout.id); setLayoutOpen(false); }}><LayoutIcon type={layout.id} active={state.layout === layout.id} /><span>{layout.short}</span></button>)}</div>
          </div>}
        </div>
        <button className="shell-icon-button density-toggle" onClick={toggleDensity} title={`Density: ${density}`} aria-label={`Use ${density === 'compact' ? 'comfortable' : 'compact'} density`}><UiIcon name="density" /></button>
        <div className="relative" ref={themeRef}>
          <button className={`shell-icon-button theme-trigger theme-${theme}`} onClick={() => setThemeOpen((open) => !open)} title={`Theme: ${theme}`} aria-label={`Choose appearance theme. Current: ${theme}`} aria-haspopup="menu" aria-expanded={themeOpen}>
            <UiIcon name={theme === 'light' ? 'sun' : 'moon'} />
          </button>
          {themeOpen && <div className="theme-menu" role="menu" aria-label="Appearance theme">
            <div className="menu-label">Appearance</div>
            {THEME_OPTIONS.map((option) => <button key={option.id} role="menuitemradio" aria-checked={theme === option.id} className={`theme-option ${theme === option.id ? 'is-active' : ''}`} onClick={() => { onThemeChange(option.id); setThemeOpen(false); }}>
              <span className={`theme-swatch theme-swatch-${option.id}`} aria-hidden="true" />
              <span><strong>{option.label}</strong><small>{option.detail}</small></span>
              {theme === option.id && <span className="theme-check" aria-hidden="true">✓</span>}
            </button>)}
          </div>}
        </div>
        <button className="shell-icon-button logout-button" onClick={() => setLogoutOpen(true)} title="Log out" aria-label="Log out"><UiIcon name="logout" /></button>
      </div>
    </nav>

    <Dialog.Root open={paletteOpen} onOpenChange={setPaletteOpen}>
      <Dialog.Portal><Dialog.Overlay className="command-overlay" /><Dialog.Content className="command-dialog" onOpenAutoFocus={(event) => { event.preventDefault(); commandInput.current?.focus(); }} onCloseAutoFocus={(event) => { if (focusSearchAfterClose.current) { event.preventDefault(); focusSearchAfterClose.current = false; searchRef.current?.querySelector('input')?.focus(); } }}>
        <Dialog.Title className="sr-only">Workspace commands</Dialog.Title>
        <Dialog.Description className="sr-only">Search views, layouts, and appearance settings. Use arrow keys and Enter to select.</Dialog.Description>
        <div className="command-input-row"><UiIcon name="search" size={20} /><input ref={commandInput} value={query} onChange={(event) => { setQuery(event.target.value); setSelected(0); }} placeholder="Where would you like to go?" role="combobox" aria-label="Search commands" aria-expanded="true" aria-controls="command-results" aria-activedescendant={filtered.length ? `command-${activeIndex}` : undefined} onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setSelected((activeIndex + (event.key === 'ArrowDown' ? 1 : -1) + filtered.length) % (filtered.length || 1)); }
          if (event.key === 'Enter') { event.preventDefault(); runCommand(activeIndex); }
        }} /><Dialog.Close className="shell-icon-button" aria-label="Close commands"><UiIcon name="close" /></Dialog.Close></div>
        <div className="command-results" id="command-results" role="listbox" aria-label="Commands">
          {!filtered.length && <div className="command-empty">No commands found. Try “chart”, “layout”, or “theme”.</div>}
          {filtered.map((command, index) => <div key={command.id} id={`command-${index}`} role="option" aria-selected={index === activeIndex} className={`command-result ${index === activeIndex ? 'is-active' : ''}`} onMouseMove={() => setSelected(index)} onClick={() => runCommand(index)}><span><strong>{command.label}</strong><small>{command.detail}</small></span>{command.key && <kbd>{command.key}</kbd>}</div>)}
        </div>
        <div className="command-footer"><span><kbd>↑</kbd><kbd>↓</kbd> Navigate <kbd>Enter</kbd> Open</span><span><kbd>Esc</kbd> Close</span></div>
        <div className="shortcut-guide"><span><kbd>/</kbd> Symbols</span><span><kbd>Ctrl K</kbd> Commands</span><span>Chart: <kbd>← →</kbd> Pan · <kbd>+ −</kbd> Zoom · <kbd>Home</kbd> Reset</span></div>
      </Dialog.Content></Dialog.Portal>
    </Dialog.Root>
    <ConfirmDialog open={logoutOpen} title="Log out?" message={logoutError || "You'll need to sign in again with OTP and MPIN."} confirmLabel="Log out" danger busy={loggingOut} onConfirm={doLogout} onCancel={() => setLogoutOpen(false)} />
  </>;
}
