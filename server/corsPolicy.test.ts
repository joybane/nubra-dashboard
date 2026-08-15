import { describe, expect, it } from 'vitest';
import { buildAllowedOrigins, isAllowedOrigin } from './corsPolicy.ts';

const allowed = buildAllowedOrigins({ port: 3000 });

describe('buildAllowedOrigins', () => {
  it('covers the server port and the Vite dev ports, in both host spellings', () => {
    expect(allowed).toEqual(
      new Set([
        'http://localhost:3000',
        'http://127.0.0.1:3000',
        'http://localhost:8000',
        'http://127.0.0.1:8000',
        'http://localhost:5173',
        'http://127.0.0.1:5173',
      ]),
    );
  });

  it('adds operator-named origins and ignores blank entries', () => {
    const withExtra = buildAllowedOrigins({
      port: 3000,
      extra: 'http://192.168.1.20:8000, ,https://desk.example.com',
    });
    expect(withExtra.has('http://192.168.1.20:8000')).toBe(true);
    expect(withExtra.has('https://desk.example.com')).toBe(true);
    expect(withExtra.has('')).toBe(false);
  });

  it('honours a non-default SERVER_PORT', () => {
    const onEight = buildAllowedOrigins({ port: 8080 });
    expect(onEight.has('http://localhost:8080')).toBe(true);
    expect(onEight.has('http://localhost:3000')).toBe(false);
  });
});

describe('isAllowedOrigin', () => {
  it('allows the app’s own origins', () => {
    expect(isAllowedOrigin('http://localhost:8000', allowed)).toBe(true);
    expect(isAllowedOrigin('http://127.0.0.1:3000', allowed)).toBe(true);
  });

  it('refuses a foreign site — the case that could previously place orders', () => {
    // Before this policy, `origin: true` reflected whatever was asked for, so any page the
    // user had open could script the paper book and the broker proxy.
    expect(isAllowedOrigin('https://evil.example.com', allowed)).toBe(false);
    expect(isAllowedOrigin('http://localhost.evil.com', allowed)).toBe(false);
    expect(isAllowedOrigin('http://localhost:9999', allowed)).toBe(false);
  });

  it('does not confuse a matching prefix or a different scheme for the real origin', () => {
    expect(isAllowedOrigin('https://localhost:8000', allowed)).toBe(false);
    expect(isAllowedOrigin('http://localhost:8000.evil.com', allowed)).toBe(false);
  });

  it('allows a request with no Origin — same-origin navigation, curl, server-to-server', () => {
    expect(isAllowedOrigin(undefined, allowed)).toBe(true);
    expect(isAllowedOrigin('', allowed)).toBe(true);
  });
});
