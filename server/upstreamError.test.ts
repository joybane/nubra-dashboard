import { describe, expect, test } from 'vitest';
import {
  describeUpstreamError,
  isTransportError,
  upstreamPostRetries,
  upstreamTimeoutMs,
} from './upstreamError.ts';

describe('describeUpstreamError', () => {
  test('unwraps the cause chain that Node hides behind "fetch failed"', () => {
    const failure = describeUpstreamError(
      new TypeError('fetch failed', {
        cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }),
      }),
    );

    // The message stays verbatim — callers substring-match it.
    expect(failure.message).toBe('fetch failed');
    expect(failure.detail).toContain('fetch failed');
    expect(failure.detail).toContain('other side closed');
    expect(failure.code).toBe('UND_ERR_SOCKET');
    expect(failure.kind).toBe('transport');
  });

  test('classifies a connection refusal as transport', () => {
    const failure = describeUpstreamError(
      new TypeError('fetch failed', {
        cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
      }),
    );
    expect(failure.kind).toBe('transport');
    expect(failure.code).toBe('ECONNREFUSED');
  });

  test('still classifies "fetch failed" as transport when no cause is attached', () => {
    // undici does not always populate `cause`, and this is exactly the failure the GET retry
    // exists to recover from — so it must not fall through to "unknown".
    expect(describeUpstreamError(new TypeError('fetch failed')).kind).toBe('transport');
    expect(isTransportError(new TypeError('fetch failed'))).toBe(true);
  });

  test('does not loop forever on a self-referential cause', () => {
    const err = new Error('loop') as Error & { cause?: unknown };
    err.cause = err;
    expect(describeUpstreamError(err).detail).toBe('loop');
  });

  test('caps how deep it walks', () => {
    let err = new Error('deepest');
    for (let i = 0; i < 12; i++) err = new Error(`level-${i}`, { cause: err });
    expect(describeUpstreamError(err).detail.split(' → ')).toHaveLength(5);
  });

  test('reads a non-Error value without throwing', () => {
    expect(describeUpstreamError('plain string').message).toBe('plain string');
    expect(describeUpstreamError(null).detail).toBe('unknown error');
  });
});

describe('isTransportError', () => {
  test('is FALSE for our own timeout — retrying one would double the wall clock', () => {
    const timeout = new Error('The operation was aborted due to timeout');
    timeout.name = 'TimeoutError';

    expect(describeUpstreamError(timeout).kind).toBe('timeout');
    expect(isTransportError(timeout)).toBe(false);
  });

  test('is FALSE for an HTTP status — 401/403 already drove onBrokerAuthFailure', () => {
    const httpErr = new Error('HTTP 403: forbidden');
    expect(describeUpstreamError(httpErr).kind).toBe('http');
    expect(isTransportError(httpErr)).toBe(false);
  });

  test('sees through our timeout wrapper to the TimeoutError underneath', () => {
    const inner = new Error('aborted');
    inner.name = 'TimeoutError';
    const wrapped = new Error('upstream timeout after 12000ms: GET /optionchains/X', {
      cause: inner,
    });
    // The wrapper itself carries no name/code, so classification must reach the cause.
    expect(isTransportError(wrapped)).toBe(false);
  });
});

describe('upstreamTimeoutMs', () => {
  test('gives the instrument-master download room to finish', () => {
    // ~100k records, tens of MB. A short budget here is a permanent search outage.
    expect(upstreamTimeoutMs('/refdata/refdata/2026-08-12')).toBeGreaterThanOrEqual(45_000);
  });

  test('keeps human-facing auth calls generous', () => {
    // A false timeout in reauthSilently logs the user out mid-session.
    expect(upstreamTimeoutMs('/sendphoneotp')).toBeGreaterThanOrEqual(30_000);
    expect(upstreamTimeoutMs('/verifypin')).toBeGreaterThanOrEqual(30_000);
  });

  test('keeps backtest chart fan-out generous', () => {
    expect(upstreamTimeoutMs('/charts/timeseries')).toBeGreaterThanOrEqual(30_000);
  });

  test('holds option chains to a short budget', () => {
    expect(upstreamTimeoutMs('/optionchains/CRUDEOIL')).toBeLessThanOrEqual(15_000);
    expect(upstreamTimeoutMs('/optionchains/CRUDEOIL/price')).toBeLessThanOrEqual(
      upstreamTimeoutMs('/optionchains/CRUDEOIL'),
    );
  });

  test('falls back to a bounded default for anything unrecognised', () => {
    const fallback = upstreamTimeoutMs('/some/new/endpoint');
    expect(fallback).toBeGreaterThan(0);
    expect(fallback).toBeLessThanOrEqual(20_000);
  });
});

describe('upstreamPostRetries', () => {
  test('never retries an OTP or PIN POST — a retry is a second SMS to the user', () => {
    expect(upstreamPostRetries('/sendphoneotp')).toBe(0);
    expect(upstreamPostRetries('/verifyphoneotp')).toBe(0);
    expect(upstreamPostRetries('/verifypin')).toBe(0);
  });

  test('fails closed for anything unrecognised', () => {
    // A new endpoint must not silently inherit retries; opting in is a deliberate act.
    expect(upstreamPostRetries('/some/new/endpoint')).toBe(0);
    expect(upstreamPostRetries('/sentinel/orders/funds_required')).toBe(0);
  });

  test('retries the backtest chart fan-out, whose batch dies on one stale socket', () => {
    expect(upstreamPostRetries('/charts/timeseries')).toBeGreaterThanOrEqual(1);
  });

  test('bounds the retry count so a failure cannot become a hang', () => {
    expect(upstreamPostRetries('/charts/timeseries')).toBeLessThanOrEqual(2);
  });
});
