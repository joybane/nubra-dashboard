import type { ReactNode } from 'react';
import { WorkspaceCtx, useWorkspaceStateCore } from './useWorkspaceState';

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const api = useWorkspaceStateCore();
  return <WorkspaceCtx.Provider value={api}>{children}</WorkspaceCtx.Provider>;
}
