import { describe, expect, it } from 'vitest';
import { formatInstrumentName, instrumentSearchAlias } from './instrumentDisplay';

describe('formatInstrumentName', () => {
  it('formats MCX futures like Nubra instead of exposing the vendor symbol', () => {
    expect(
      formatInstrumentName({
        stock_name: 'FUT_CRUDEOIL_20260819',
        zanskar_name: 'FUT_CRUDEOIL_20260819',
        exchange: 'MCX',
        derivative_type: 'FUT',
        asset: 'CRUDEOIL',
        expiry: '20260819',
      }),
    ).toBe('CRUDEOIL AUG 26 FUT');
  });

  it('formats MCX options with expiry, rupee strike, and option type', () => {
    expect(
      formatInstrumentName({
        zanskar_name: 'OPT_CRUDEOIL_20260817_CE_875000',
        derivative_type: 'OPT',
        asset_type: 'COM_FO',
      }),
    ).toBe('CRUDEOIL 17 AUG 26 8,750 CE');
  });

  it('formats field-based NSE futures and weekly options', () => {
    expect(
      formatInstrumentName({
        stock_name: 'NIFTY',
        derivative_type: 'FUT',
        expiry: 20260827,
      }),
    ).toBe('NIFTY AUG 26 FUT');
    expect(
      formatInstrumentName({
        stock_name: 'NIFTY',
        derivative_type: 'OPT',
        expiry: '20260806',
        strike_price: 25_000 * 100,
        option_type: 'PE',
      }),
    ).toBe('NIFTY 06 AUG 26 25,000 PE');
  });

  it('keeps descriptive cash names and exposes their ticker as an alias', () => {
    const equity = {
      stock_name: 'RELIANCE INDUSTRIES LTD',
      nubra_name: 'RELIANCE',
      asset: 'RELIANCE',
      derivative_type: 'STOCK',
    };
    expect(formatInstrumentName(equity)).toBe('RELIANCE INDUSTRIES LTD');
    expect(instrumentSearchAlias(equity)).toBe('RELIANCE');
  });

  it('turns underscore-separated index names into readable text', () => {
    expect(formatInstrumentName({ stock_name: 'INDIA_VIX', derivative_type: 'INDEX' })).toBe(
      'INDIA VIX',
    );
  });
});
