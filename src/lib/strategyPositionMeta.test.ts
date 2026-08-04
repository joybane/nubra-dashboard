import { describe, expect, it } from 'vitest';
import type { Instrument, PaperPosition } from '../types';
import {
  resolveMcxStrategyFuture,
  strategyChartSubscription,
  strategyPositionAsset,
  strategyPositionExchange,
  strategyPositionExpiry,
} from './strategyPositionMeta';

const position = {
  ref_id: 1,
  display_name: 'CRUDEOIL 7550 PE',
  zanskar_name: 'OPT_CRUDEOIL_20260817_PE_755000',
  qty: 100,
  avg_price: 32934,
  last_traded_price: 32940,
  pnl: -600,
} satisfies PaperPosition;

describe('strategy commodity metadata', () => {
  it('detects MCX from the trading name even when the display name is readable', () => {
    expect(strategyPositionAsset([position])).toBe('CRUDEOIL');
    expect(strategyPositionExchange([position])).toBe('MCX');
    expect(strategyPositionExpiry(position)).toBe('20260817');
  });

  it('maps the option expiry to its backing futures contract', () => {
    const futures: Instrument[] = [
      { zanskar_name: 'FUT_CRUDEOIL_20260921', expiry: '20260921' },
      { zanskar_name: 'FUT_CRUDEOIL_20260819', expiry: '20260819' },
    ];
    expect(resolveMcxStrategyFuture('CRUDEOIL', [position], futures)).toBe('FUT_CRUDEOIL_20260819');
  });

  it('subscribes commodity futures through the Nubra indexes input', () => {
    expect(strategyChartSubscription('FUT_CRUDEOIL_20260819', 'MCX')).toEqual({
      indexes: ['FUT_CRUDEOIL_20260819'],
    });
    expect(strategyChartSubscription('NIFTY', 'NSE')).toEqual({ indexes: ['NIFTY'] });
  });
});
