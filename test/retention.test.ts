import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pruneOlderThan } from '../src/shared/retention.js';

const DAY = 24 * 60 * 60_000;

describe('pruneOlderThan', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('deletes journal days and run folders older than the retention, and keeps the rest', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'poo-retention-'));
    const now = Date.now();
    const age = async (name: string, days: number) => {
      const when = new Date(now - days * DAY);
      await utimes(path.join(dir!, name), when, when);
    };
    await writeFile(path.join(dir, '2026-09-01.jsonl'), '{}\n');
    await mkdir(path.join(dir, 'old-task', 'qa'), { recursive: true });
    await writeFile(path.join(dir, 'today.jsonl'), '{}\n');
    await age('2026-09-01.jsonl', 30);
    await age('old-task', 20);

    expect((await pruneOlderThan(dir, 14, now)).sort()).toEqual(['2026-09-01.jsonl', 'old-task']);
    expect(await readdir(dir)).toEqual(['today.jsonl']);
    expect(await pruneOlderThan(dir, 0, now + 365 * DAY)).toEqual([]);
    expect(await pruneOlderThan(path.join(dir, 'missing'), 14)).toEqual([]);
  });
});
