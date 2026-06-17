import { useCallback, useState } from 'react';
import type { Instrument, LayoutType, ViewType } from '../types';
import { useWorkspaceState } from './useWorkspaceState';
import PaneShell from './PaneShell';
import SplitDivider from './SplitDivider';
import LayoutPicker from './LayoutPicker';

interface WorkspaceRootProps {
  theme: 'dark' | 'light';
}

export default function WorkspaceRoot({ theme }: WorkspaceRootProps) {
  const {
    state, setLayout, setPaneView, setActivePane, loadInstrumentInActivePane,
  } = useWorkspaceState();

  const [sizes, setSizes] = useState<number[]>([50, 50]);

  const handleResize = useCallback((idx: number, delta: number, containerSize: number) => {
    setSizes((prev) => {
      const next = [...prev];
      const pct  = (delta / containerSize) * 100;
      next[idx]     = Math.max(15, next[idx] + pct);
      next[idx + 1] = Math.max(15, next[idx + 1] - pct);
      return next;
    });
  }, []);

  const navigateToChart = useCallback((paneId: string) => (inst: Instrument) => {
    setActivePane(paneId);
    setPaneView(paneId, 'chart');         // switch the pane to chart view
    loadInstrumentInActivePane(inst);
  }, [setActivePane, setPaneView, loadInstrumentInActivePane]);

  const { layout, panes, activePane } = state;

  function renderPane(idx: number) {
    const pane = panes[idx];
    if (!pane) return null;
    return (
      <div key={pane.id} className="flex-1 overflow-hidden min-w-0 min-h-0">
        <PaneShell
          pane={pane}
          theme={theme}
          isActive={pane.id === activePane}
          onActivate={() => setActivePane(pane.id)}
          onViewChange={(v: ViewType) => setPaneView(pane.id, v)}
          onNavigateToChart={navigateToChart(pane.id)}
        />
      </div>
    );
  }

  const divH = () => (
    <SplitDivider direction="horizontal" onResize={(d) => {
      const cont = document.getElementById('workspace-root');
      handleResize(0, d, cont?.clientWidth || 800);
    }} />
  );
  const divV = () => (
    <SplitDivider direction="vertical" onResize={(d) => {
      const cont = document.getElementById('workspace-root');
      handleResize(0, d, cont?.clientHeight || 600);
    }} />
  );

  const renderLayout = () => {
    switch (layout) {
      case 'single':
        return <div className="flex h-full overflow-hidden">{renderPane(0)}</div>;

      case 'hsplit':
        return (
          <div className="flex h-full" style={{ '--s0': `${sizes[0] || 50}`, '--s1': `${sizes[1] || 50}` } as React.CSSProperties}>
            <div style={{ flex: `${sizes[0] || 50} 1 0` }} className="overflow-hidden min-w-0">{renderPane(0)}</div>
            {divH()}
            <div style={{ flex: `${sizes[1] || 50} 1 0` }} className="overflow-hidden min-w-0">{renderPane(1)}</div>
          </div>
        );

      case 'vsplit':
        return (
          <div className="flex flex-col h-full">
            <div style={{ flex: `${sizes[0] || 50} 1 0` }} className="overflow-hidden min-h-0">{renderPane(0)}</div>
            {divV()}
            <div style={{ flex: `${sizes[1] || 50} 1 0` }} className="overflow-hidden min-h-0">{renderPane(1)}</div>
          </div>
        );

      case 'grid':
        return (
          <div className="flex flex-col h-full">
            <div className="flex flex-1 overflow-hidden min-h-0">
              {renderPane(0)}
              <div className="w-px bg-[var(--border)] shrink-0" />
              {renderPane(1)}
            </div>
            <div className="h-px bg-[var(--border)] shrink-0" />
            <div className="flex flex-1 overflow-hidden min-h-0">
              {renderPane(2)}
              <div className="w-px bg-[var(--border)] shrink-0" />
              {renderPane(3)}
            </div>
          </div>
        );

      case 'tleft':
        return (
          <div className="flex h-full">
            <div className="flex-[2] overflow-hidden min-w-0">{renderPane(0)}</div>
            <div className="w-px bg-[var(--border)] shrink-0" />
            <div className="flex-1 flex flex-col overflow-hidden min-w-0">
              <div className="flex-1 overflow-hidden min-h-0">{renderPane(1)}</div>
              <div className="h-px bg-[var(--border)] shrink-0" />
              <div className="flex-1 overflow-hidden min-h-0">{renderPane(2)}</div>
            </div>
          </div>
        );

      case 'tright':
        return (
          <div className="flex h-full">
            <div className="flex-1 flex flex-col overflow-hidden min-w-0">
              <div className="flex-1 overflow-hidden min-h-0">{renderPane(0)}</div>
              <div className="h-px bg-[var(--border)] shrink-0" />
              <div className="flex-1 overflow-hidden min-h-0">{renderPane(1)}</div>
            </div>
            <div className="w-px bg-[var(--border)] shrink-0" />
            <div className="flex-[2] overflow-hidden min-w-0">{renderPane(2)}</div>
          </div>
        );
    }
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Layout picker bar */}
      <div className="h-8 bg-[var(--bg-secondary)] border-b border-[var(--border)] flex items-center px-3 shrink-0 gap-2">
        <LayoutPicker current={layout as LayoutType} onChange={setLayout} />
        {panes.length > 1 && (
          <span className="text-[10px] text-[var(--text-muted)]">
            Click a pane to activate it, then search to load a symbol
          </span>
        )}
      </div>

      <div id="workspace-root" className="flex-1 overflow-hidden">
        {renderLayout()}
      </div>
    </div>
  );
}
