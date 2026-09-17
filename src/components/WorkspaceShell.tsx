import type { ReactNode } from 'react';
import type { ViewType } from '../types';
import { useWorkspaceState } from '../workspace/useWorkspaceState';
import { VIEW_LABELS } from '../workspace/viewConfig';
import UiIcon, { type IconName } from './UiIcon';

interface ViewGroup {
  id: string;
  label: string;
  icon: IconName;
  views: ViewType[];
}

const GROUPS: ViewGroup[] = [
  { id: 'trade', label: 'Trade', icon: 'trade', views: ['chart', 'optionchain'] },
  { id: 'strategies', label: 'Strategies', icon: 'strategy', views: ['basket', 'backtest'] },
  { id: 'research', label: 'Research', icon: 'research', views: ['nubrabacktest', 'analysis'] },
  { id: 'monitor', label: 'Monitor', icon: 'monitor', views: ['watchlist', 'tracker'] },
];

export default function WorkspaceShell({ children }: { children: ReactNode }) {
  const { state, setPaneView } = useWorkspaceState();
  const paneId = state.activePane || state.panes[0]?.id;
  const pane = state.panes.find((item) => item.id === paneId) || state.panes[0];
  const activeGroup = GROUPS.find((group) => group.views.includes(pane?.view)) || GROUPS[0];
  const openView = (view: ViewType) => paneId && setPaneView(paneId, view);

  return <div className="workspace-shell-frame">
    <aside className="workspace-rail" aria-label="Workspace groups">
      <span className="workspace-rail-label">Workspace</span>
      {GROUPS.map((group) => <button key={group.id} className={`workspace-rail-item ${activeGroup.id === group.id ? 'is-active' : ''}`} aria-current={activeGroup.id === group.id ? 'page' : undefined} onClick={() => openView(group.views[0])}>
        <UiIcon name={group.icon} size={20} />
        <span>{group.label}</span>
      </button>)}
      <span className="workspace-rail-spacer" />
      <div className="workspace-rail-hint"><UiIcon name="command" size={17} /><span>Commands</span></div>
    </aside>
    <section className="workspace-shell-content">
      <nav className="workspace-view-tabs" aria-label={`${activeGroup.label} views`}>
        <strong>{activeGroup.label}</strong>
        {activeGroup.views.map((view) => <button key={view} className={pane?.view === view ? 'is-active' : ''} aria-current={pane?.view === view ? 'page' : undefined} onClick={() => openView(view)}>{VIEW_LABELS[view]}</button>)}
        <span>Your workspace</span>
      </nav>
      <div className="workspace-shell-body">{children}</div>
    </section>
  </div>;
}
