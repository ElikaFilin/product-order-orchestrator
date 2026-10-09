import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';

const DAY_MS = 24 * 60 * 60_000;

/**
 * Delete the entries of `dir` (files or folders) last changed more than `days` days ago; 0 keeps everything.
 * Runtime files hold page text and browsing data, so they must not pile up forever. Never throws.
 */
export async function pruneOlderThan(dir: string, days: number, now = Date.now()): Promise<string[]> {
  if (days <= 0) return [];
  const cutoff = now - days * DAY_MS;
  const removed: string[] = [];
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    const full = path.join(dir, name);
    const info = await stat(full).catch(() => undefined);
    if (!info || info.mtimeMs >= cutoff) continue;
    await rm(full, { recursive: true, force: true }).catch(() => undefined);
    removed.push(name);
  }
  return removed;
}
