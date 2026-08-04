import { describe, expect, it } from 'vitest';
import { buildInstrumentSearchIndex, searchInstrumentIndex } from './instrumentSearchIndex';

describe('instrument search index', () => {
  const items = [
    {
      stock_name: 'FUT_CRUDEOILM_20260819',
      asset: 'CRUDEOILM',
      derivative_type: 'FUT',
    },
    {
      stock_name: 'FUT_CRUDEOIL_20270919',
      asset: 'CRUDEOIL',
      derivative_type: 'FUT',
    },
    {
      stock_name: 'FUT_CRUDEOIL_20260819',
      asset: 'CRUDEOIL',
      derivative_type: 'FUT',
    },
  ];

  it('precomputes terms once and returns exact assets by nearest expiry', () => {
    const index = buildInstrumentSearchIndex(items);
    expect(searchInstrumentIndex(index, 'crudeoil').map((item) => item.stock_name)).toEqual([
      'FUT_CRUDEOIL_20260819',
      'FUT_CRUDEOIL_20270919',
      'FUT_CRUDEOILM_20260819',
    ]);
  });

  it('searches the readable contract label and respects type filters', () => {
    const index = buildInstrumentSearchIndex(items);
    expect(searchInstrumentIndex(index, 'aug 26', 'FUT')).toHaveLength(2);
    expect(searchInstrumentIndex(index, 'aug 26', 'OPT')).toEqual([]);
  });
});
