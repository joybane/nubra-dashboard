import type { FastifyReply } from 'fastify';
import { describeUpstreamError } from './upstreamError.ts';

/**
 * Standard 500 for a failed call out to Nubra.
 *
 * `error` stays byte-identical to the raw upstream message because the frontend pattern-matches
 * it: isOptionChainUnavailableError in src/OptionChain.tsx navigates the pane away to the chart
 * view when the text contains "option chain"/"not fno"/"no chain". Anything we want to add for
 * diagnosis goes in `detail`, never in `error`.
 *
 * Use this for UPSTREAM failures only. Validation and auth replies keep their existing bare
 * `{ error }` bodies — tests assert those with toEqual, which fails on extra keys.
 */
export function sendUpstreamError(reply: FastifyReply, err: unknown, context: string) {
  const failure = describeUpstreamError(err);
  console.warn(`[api] ${context} failed: ${failure.detail}`);
  return reply
    .status(500)
    .send({ error: failure.message, detail: failure.detail, code: failure.code });
}
