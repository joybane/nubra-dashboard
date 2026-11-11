import { describe, expect, it } from 'vitest';
import { OPEN_DAY_MESSAGE, withExplorerHook } from './maxLossReport.ts';

const page = (body: string) =>
  `<script>(async () => {\n  async function openDay(date, key, list) {\n${body}\n  }\n})();</script>`;

describe('withExplorerHook', () => {
  it('hands day-clicks to the parent page and leaves the rest of the report alone', () => {
    const html = page('    DV.list = list;');
    const hooked = withExplorerHook(html)!;
    expect(hooked).toContain(OPEN_DAY_MESSAGE);
    expect(hooked).toContain('location.origin); return; }');
    expect(hooked.replace(/ if \(window\.parent !== window\).*?return; \}/, '')).toBe(html);
  });

  it('refuses a report whose openDay is missing or appears twice', () => {
    expect(withExplorerHook('<p>no script</p>')).toBeNull();
    expect(withExplorerHook(page('') + page(''))).toBeNull();
  });
});
