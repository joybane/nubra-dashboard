/**
 * Tiny gated logger.
 *
 * `debug`/`info` are silenced in production builds unless the user opts in by
 * setting `localStorage['nubra-debug'] = '1'` — so the console stays clean for
 * normal use but full tracing is one flag away when diagnosing an issue.
 * `warn`/`error` always pass through (they signal real problems).
 */
const isDev = typeof import.meta !== 'undefined' && import.meta.env?.DEV === true;

function debugEnabled(): boolean {
  if (isDev) return true;
  try {
    return localStorage.getItem('nubra-debug') === '1';
  } catch {
    return false;
  }
}

export const logger = {
  debug: (...args: unknown[]) => {
    if (debugEnabled()) console.debug(...args);
  },
  info: (...args: unknown[]) => {
    if (debugEnabled()) console.info(...args);
  },
  warn: (...args: unknown[]) => console.warn(...args),
  error: (...args: unknown[]) => console.error(...args),
};
