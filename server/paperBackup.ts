// ─────────────────────────────────────────────────────────────────────────────
// Daily copies of paper.db.
//
// paper.db holds every paper trade, position, rule and snapshot, and there was no copy of it
// beyond one taken by hand before a cleanup. This keeps one file per IST day, taken at startup
// (if today has none yet) and in the pre-market housekeeping slot, and prunes to the newest few.
//
// Same disk by default, so it guards against a bad migration, a corrupt file or an accidental
// delete — not a failed drive. Point PAPER_BACKUP_DIR at another drive for that.
// ─────────────────────────────────────────────────────────────────────────────
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'fs';
import path from 'path';

const FILE_RE = /^paper-(\d{4}-\d{2}-\d{2})\.db$/;

export interface BackupResult {
  /** The file written this run, or null when today's copy already existed. */
  written: string | null;
  /** Older copies removed to stay within `keep`. */
  pruned: string[];
}

/**
 * Write `<dir>/paper-<dateKey>.db` via `copy` unless it already exists, then keep only the newest
 * `keep` dated copies. The copy goes to a temp name first, so a crash mid-copy never leaves a
 * truncated file wearing a real backup's name.
 */
export async function runPaperBackup(opts: {
  dir: string;
  dateKey: string;
  keep: number;
  copy: (dest: string) => Promise<void>;
}): Promise<BackupResult> {
  const { dir, dateKey, keep, copy } = opts;
  mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `paper-${dateKey}.db`);
  let written: string | null = null;
  if (!existsSync(target)) {
    const tmp = `${target}.partial`;
    rmSync(tmp, { force: true });
    await copy(tmp);
    renameSync(tmp, target);
    written = target;
  }
  const dated = readdirSync(dir)
    .filter((f) => FILE_RE.test(f))
    .sort()
    .reverse(); // ISO dates sort lexically: newest first
  const pruned: string[] = [];
  for (const f of dated.slice(Math.max(1, keep))) {
    rmSync(path.join(dir, f), { force: true });
    pruned.push(f);
  }
  return { written, pruned };
}
