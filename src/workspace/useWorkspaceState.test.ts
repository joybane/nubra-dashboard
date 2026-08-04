import { describe, expect, it } from 'vitest';
import type { Instrument, WorkspaceState } from '../types';
import { withInstrumentInActivePane } from './useWorkspaceState';

const crude: Instrument = {
  stock_name: 'FUT_CRUDEOIL_20260819',
  asset: 'CRUDEOIL',
  exchange: 'MCX',
  derivative_type: 'FUT',
};

function workspace(view: 'optionchain' | 'nubrabacktest'): WorkspaceState {
  return {
    layout: 'single',
    activePane: 'pane-1',
    panes: [
      {
        id: 'pane-1',
        view,
        instrument: { stock_name: 'NIFTY 50', nubra_name: 'NIFTY', exchange: 'NSE' },
      },
    ],
  };
}

describe('global instrument selection', () => {
  it.each(['optionchain', 'nubrabacktest'] as const)(
    'keeps the %s view active while changing its instrument',
    (view) => {
      const next = withInstrumentInActivePane(workspace(view), crude);
      expect(next.panes[0].view).toBe(view);
      expect(next.panes[0].instrument).toBe(crude);
    },
  );
});
