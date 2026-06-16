import { createContext, useCallback, useContext, useState } from 'react';
import type { Instrument, LayoutType, PaneState, ViewType, WorkspaceState } from '../types';
import { generateId } from '../lib/utils';

function defaultPane(view: ViewType = 'chart'): PaneState {
  return { id: generateId(), view, instrument: null };
}

function defaultState(): WorkspaceState {
  return { layout: 'single', panes: [defaultPane('chart')], activePane: '' };
}

function loadState(): WorkspaceState {
  try {
    const saved = localStorage.getItem('nubra-workspace');
    if (saved) return JSON.parse(saved) as WorkspaceState;
  } catch { /* ignore */ }
  return defaultState();
}

function saveState(s: WorkspaceState): void {
  try { localStorage.setItem('nubra-workspace', JSON.stringify(s)); } catch { /* ignore */ }
}

export const LAYOUT_PANE_COUNT: Record<LayoutType, number> = {
  single: 1, hsplit: 2, vsplit: 2, grid: 4, tleft: 3, tright: 3,
};

export function useWorkspaceStateCore() {
  const [state, setState] = useState<WorkspaceState>(() => {
    const loaded = loadState();
    const needed = LAYOUT_PANE_COUNT[loaded.layout] || 1;
    while (loaded.panes.length < needed) loaded.panes.push(defaultPane());
    if (loaded.panes.length > needed) loaded.panes = loaded.panes.slice(0, needed);
    if (!loaded.activePane) loaded.activePane = loaded.panes[0]?.id || '';
    return loaded;
  });

  const update = useCallback((updater: (prev: WorkspaceState) => WorkspaceState) => {
    setState((prev) => {
      const next = updater(prev);
      saveState(next);
      return next;
    });
  }, []);

  const setLayout = useCallback((layout: LayoutType) => {
    update((prev) => {
      const needed = LAYOUT_PANE_COUNT[layout];
      const panes  = [...prev.panes];
      while (panes.length < needed) panes.push(defaultPane());
      const trimmed = panes.slice(0, needed);
      const active  = trimmed.some((p) => p.id === prev.activePane)
        ? prev.activePane : (trimmed[0]?.id || '');
      return { layout, panes: trimmed, activePane: active };
    });
  }, [update]);

  const setPaneView = useCallback((paneId: string, view: ViewType) => {
    update((prev) => ({
      ...prev,
      panes: prev.panes.map((p) => p.id === paneId ? { ...p, view } : p),
    }));
  }, [update]);

  const setPaneInstrument = useCallback((paneId: string, instrument: Instrument) => {
    update((prev) => ({
      ...prev,
      panes: prev.panes.map((p) => p.id === paneId ? { ...p, instrument } : p),
    }));
  }, [update]);

  const setActivePane = useCallback((paneId: string) => {
    update((prev) => ({ ...prev, activePane: paneId }));
  }, [update]);

  const loadInstrumentInActivePane = useCallback((instrument: Instrument) => {
    update((prev) => ({
      ...prev,
      panes: prev.panes.map((p) =>
        p.id === (prev.activePane || prev.panes[0]?.id) ? { ...p, instrument } : p,
      ),
    }));
  }, [update]);

  return { state, setLayout, setPaneView, setPaneInstrument, setActivePane, loadInstrumentInActivePane };
}

export type WorkspaceAPI = ReturnType<typeof useWorkspaceStateCore>;

// Context (no JSX here — provider lives in WorkspaceProvider.tsx)
export const WorkspaceCtx = createContext<WorkspaceAPI | null>(null);

export function useWorkspaceState(): WorkspaceAPI {
  const ctx = useContext(WorkspaceCtx);
  if (!ctx) throw new Error('useWorkspaceState must be inside WorkspaceProvider');
  return ctx;
}
