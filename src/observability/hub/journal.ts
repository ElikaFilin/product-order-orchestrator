/**
 * Append-only JSONL event log, one file per local day (`<dir>/YYYY-MM-DD.jsonl`), so the board
 * survives a hub restart and a day's activity can be inspected with plain tools (jq, grep).
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from 'pino';
import { errorMessage } from '../../shared/logger.js';
import { ObsEvent } from '../events.js';

/** Local calendar date as YYYY-MM-DD. */
export function localDate(d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export class EventJournal {
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly dir: string,
    private readonly log: Logger,
  ) {}

  fileFor(date: Date = new Date()): string {
    return path.join(this.dir, `${localDate(date)}.jsonl`);
  }

  /** Today's events; unreadable lines are skipped. */
  async loadToday(): Promise<ObsEvent[]> {
    let text: string;
    try {
      text = await readFile(this.fileFor(), 'utf8');
    } catch {
      return [];
    }
    const events: ObsEvent[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = ObsEvent.safeParse(JSON.parse(line));
        if (parsed.success) events.push(parsed.data);
      } catch {
        // a torn last line after a crash; skip it
      }
    }
    return events;
  }

  /** Queue events for writing. Writes are serialized so lines keep arrival order; failures are logged, never thrown. */
  append(events: readonly ObsEvent[]): void {
    if (events.length === 0) return;
    const lines = events.map((e) => `${JSON.stringify(e)}\n`).join('');
    this.writing = this.writing
      .then(async () => {
        await mkdir(this.dir, { recursive: true });
        await appendFile(this.fileFor(), lines, 'utf8');
      })
      .catch((err) => this.log.warn({ err: errorMessage(err) }, 'could not write event journal'));
  }

  /** Resolves when every queued write has finished. */
  flush(): Promise<void> {
    return this.writing;
  }
}
