/**
 * Classification and budgeting for calls out to the Nubra API.
 *
 * Node's fetch reports every transport-level failure as the same opaque `TypeError: fetch failed`
 * — a dropped keep-alive socket, a refused connection and a DNS miss are indistinguishable from
 * the message alone. The real reason lives in `err.cause`, which every catch block in this server
 * used to throw away, so a stalled broker connection surfaced in the UI as the bare words
 * "fetch failed" with nothing to act on.
 *
 * `describeUpstreamError` keeps the original message byte-identical (callers substring-match it —
 * see isOptionChainUnavailableError in src/OptionChain.tsx) and puts the unwrapped cause chain in
 * a separate `detail` field.
 */

export type UpstreamErrorKind = 'transport' | 'timeout' | 'http' | 'unknown';

export interface UpstreamFailure {
  /** The original `err.message`, unchanged. Callers substring-match this — do not decorate it. */
  message: string;
  /** The unwrapped cause chain, e.g. `fetch failed → SocketError: other side closed (UND_ERR_SOCKET)`. */
  detail: string;
  /** The innermost `code` found on the cause chain, when there is one. */
  code?: string;
  kind: UpstreamErrorKind;
}

const MAX_CAUSE_DEPTH = 5;

interface ErrorLike {
  name?: unknown;
  message?: unknown;
  code?: unknown;
  cause?: unknown;
}

function asErrorLike(value: unknown): ErrorLike | null {
  return typeof value === 'object' && value !== null ? (value as ErrorLike) : null;
}

/** `TimeoutError: the operation timed out (UND_ERR_HEADERS_TIMEOUT)` — any part may be absent. */
function describeLink(err: ErrorLike): { text: string; code?: string } {
  const name = typeof err.name === 'string' && err.name && err.name !== 'Error' ? err.name : '';
  const message = typeof err.message === 'string' ? err.message : '';
  const code = typeof err.code === 'string' ? err.code : undefined;
  const head = name && message ? `${name}: ${message}` : name || message;
  return { text: code ? `${head || 'error'} (${code})` : head, code };
}

/**
 * Walks the `cause` chain, joining each link with ` → `. Depth-capped and cycle-guarded: a
 * self-referential cause is rare but a hang inside the error handler would be worse than the
 * error itself.
 */
export function describeUpstreamError(err: unknown): UpstreamFailure {
  const root = asErrorLike(err);
  const message = root && typeof root.message === 'string' ? root.message : String(err ?? '');

  const parts: string[] = [];
  const seen = new Set<unknown>();
  let code: string | undefined;
  let deepestName = '';

  let node: ErrorLike | null = root;
  for (let depth = 0; node && depth < MAX_CAUSE_DEPTH; depth++) {
    if (seen.has(node)) break;
    seen.add(node);

    const link = describeLink(node);
    if (link.text) parts.push(link.text);
    if (link.code) code = link.code;
    if (typeof node.name === 'string' && node.name) deepestName = node.name;

    node = asErrorLike(node.cause);
  }

  return {
    message,
    detail: parts.join(' → ') || message || 'unknown error',
    code,
    kind: classify(message, code, deepestName),
  };
}

function classify(message: string, code: string | undefined, name: string): UpstreamErrorKind {
  // Our own AbortSignal.timeout surfaces as TimeoutError; an explicit abort as AbortError.
  if (name === 'TimeoutError' || name === 'AbortError') return 'timeout';
  if (code === 'UND_ERR_ABORTED' || code === 'ABORT_ERR') return 'timeout';
  // A non-2xx response is thrown by nubraGet/nubraPostAt only after the transport succeeded.
  if (message.startsWith('HTTP ')) return 'http';
  if (code) return 'transport';
  if (message === 'fetch failed') return 'transport';
  return 'unknown';
}

/**
 * True only for failures where the request never got a response, so re-issuing an idempotent GET
 * is free. Deliberately FALSE for our own timeouts: retrying one would double the wall-clock
 * budget and turn a bounded failure back into the hang this whole module exists to prevent.
 */
export function isTransportError(err: unknown): boolean {
  return describeUpstreamError(err).kind === 'transport';
}

/**
 * Per-endpoint time budget, matched on the endpoint path prefix.
 *
 * Deriving this from the endpoint rather than taking it as an argument keeps the NubraGet/NubraPost
 * signatures — which are re-declared in three separate route modules — completely unchanged.
 *
 * The spread is deliberate: refdata is a multi-megabyte instrument dump that legitimately takes
 * tens of seconds, while an option chain that has not answered in 12s is not coming.
 */
export function upstreamTimeoutMs(endpoint: string): number {
  if (endpoint.startsWith('/refdata/refdata/')) return 45_000;
  if (endpoint.startsWith('/charts/timeseries')) return 30_000;
  // Human-facing OTP/PIN round trips. A false timeout here logs the user out via
  // reauthSilently's catch, so be generous.
  if (
    endpoint.startsWith('/sendphoneotp') ||
    endpoint.startsWith('/verifyphoneotp') ||
    endpoint.startsWith('/verifypin')
  )
    return 30_000;
  // Blocks the order ticket, but has a local-margin fallback, so a timeout degrades gracefully.
  if (endpoint.startsWith('/sentinel/orders/funds_required')) return 12_000;
  if (endpoint.startsWith('/optionchains/')) return endpoint.endsWith('/price') ? 8_000 : 12_000;
  return 20_000;
}
