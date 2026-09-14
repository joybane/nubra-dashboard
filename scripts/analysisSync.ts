/**
 * Fill the Analysis cache from the command line, through an already-running dashboard server.
 *
 *   node --experimental-strip-types scripts/analysisSync.ts [NIFTY]
 *
 * Broker calls go through the server's own `/api/historical` proxy, so this needs a logged-in server
 * on DASHBOARD_URL (default http://localhost:3000) but never touches its session or restarts it. The
 * parquet reading happens in this process, off the server's event loop. The Analysis tab's "Update
 * data" button runs the same job inside the server.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import { createDayStore } from '../server/analysis/daySeries.ts';
import { createAnalysisSync } from '../server/analysis/sync.ts';
import type { Underlying } from '../server/backtest/types.ts';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = process.env.DASHBOARD_URL || 'http://localhost:3000';
const underlying = (process.argv[2] || 'NIFTY').toUpperCase() as Underlying;

const post = async (body: object): Promise<Record<string, unknown>> => {
  const res = await fetch(`${base}/api/historical`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text) as Record<string, unknown>;
};

const sync = createAnalysisSync({
  store: createDayStore(path.join(root, '.analysis-cache')),
  masterDirs: [path.join(root, '.refdata-cache'), path.join(root, '.refdata-live')],
  getPost: () => post,
  log: (msg) => console.log(new Date().toISOString().slice(11, 19), msg),
});

sync.start(underlying);
const timer = setInterval(() => {
  const s = sync.getState();
  console.log(
    new Date().toISOString().slice(11, 19),
    `[progress] phase=${s.phase}`,
    `local ${s.local.done}/${s.local.total} (+${s.local.built}, ${s.local.empty} empty, ${s.local.failed} failed)`,
    `nubra ${s.nubra.done}/${s.nubra.total} (+${s.nubra.built}, ${s.nubra.empty} empty, ${s.nubra.failed} failed)`,
    s.validation.running ? `validation ${s.validation.done}/${s.validation.total}` : '',
  );
}, 30_000);
await sync.whenIdle();
clearInterval(timer);
console.log(JSON.stringify(sync.getState(), null, 2));
