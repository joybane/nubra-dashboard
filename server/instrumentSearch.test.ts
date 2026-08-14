import { expect, test } from 'vitest';
import {
  buildSearchEntries,
  refIdIndexFor,
  searchEntries,
  searchIndexFor,
} from './instrumentSearch.ts';

const MASTER = [
  { stock_name: 'NIFTYBANK', derivative_type: 'FUT' },
  { stock_name: 'NIFTY', derivative_type: 'INDEX' },
  { stock_name: 'NIFTY 25000 CE', derivative_type: 'OPT' },
];

test('ranks exact names first, then instrument kind, then nearest expiry', () => {
  const index = buildSearchEntries([
    { stock_name: 'FUT_CRUDEOILM_20260819', asset: 'CRUDEOILM', derivative_type: 'FUT' },
    { stock_name: 'FUT_CRUDEOIL_20270919', asset: 'CRUDEOIL', derivative_type: 'FUT' },
    { stock_name: 'FUT_CRUDEOIL_20260819', asset: 'CRUDEOIL', derivative_type: 'FUT' },
  ]);

  expect(searchEntries(index, 'crudeoil').map((item) => item.stock_name)).toEqual([
    'FUT_CRUDEOIL_20260819',
    'FUT_CRUDEOIL_20270919',
    'FUT_CRUDEOILM_20260819',
  ]);
});

test('honours the limit by keeping the best matches, not the first ones encountered', () => {
  // NIFTYBANK is encountered before NIFTY, so a truncate-then-rank implementation would drop the
  // exact match. This is the whole point of selecting rather than slicing.
  expect(searchEntries(buildSearchEntries(MASTER), 'nifty', '', 2)).toEqual([
    { stock_name: 'NIFTY', derivative_type: 'INDEX' },
    { stock_name: 'NIFTYBANK', derivative_type: 'FUT' },
  ]);
});

test('filters by instrument type', () => {
  expect(searchEntries(buildSearchEntries(MASTER), 'nifty', 'OPT')).toEqual([
    { stock_name: 'NIFTY 25000 CE', derivative_type: 'OPT' },
  ]);
});

test('a query spanning two names does not match, because the separator cannot be crossed', () => {
  // 'nifty' and 'reliance' are two different names on one record; a space-joined haystack would
  // report a match for the text that straddles them.
  const index = buildSearchEntries([{ asset: 'NIFTY', stock_name: 'RELIANCE' }]);
  expect(searchEntries(index, 'niftyreliance')).toEqual([]);
  expect(searchEntries(index, 'nifty')).toHaveLength(1);
});

test('an empty query lists everything, as the previous startsWith("") rule did', () => {
  expect(searchEntries(buildSearchEntries(MASTER), '')).toHaveLength(3);
});

test('returns nothing for a non-positive limit rather than an unbounded list', () => {
  expect(searchEntries(buildSearchEntries(MASTER), 'nifty', '', 0)).toEqual([]);
});

test('builds one index per master array and reuses it', () => {
  const master = [...MASTER];
  expect(searchIndexFor(master)).toBe(searchIndexFor(master));
  // A new day's master is a different array, so it gets its own index.
  expect(searchIndexFor([...MASTER])).not.toBe(searchIndexFor(master));
});

test('indexes ref_id by number, keeping the first record for a duplicate', () => {
  const master = [
    { ref_id: 7, stock_name: 'FIRST' },
    { ref_id: '7', stock_name: 'SECOND' },
    { stock_name: 'NO_REF_ID' },
  ];
  const index = refIdIndexFor(master);

  // Coerced, so a master storing ref_id as a string still resolves — the old strict === missed it.
  expect(index.get(7)?.stock_name).toBe('FIRST');
  expect(index.size).toBe(1);
  expect(refIdIndexFor(master)).toBe(index);
});
