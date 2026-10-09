/**
 * Dashboard hub: receives telemetry events from every agent process (POST /api/events), keeps them in
 * a ring buffer plus a daily JSONL journal, serves derived views over REST, pushes new events to the
 * browser over a WebSocket, and serves the static dashboard UI.
 */
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';
import { createLogger, errorMessage } from '../../shared/logger.js';
import { isLoopbackHostHeader } from '../../shared/loopback.js';
import { ObsEventBatch, type ObsEvent } from '../events.js';
import { EventJournal } from './journal.js';
import { deriveAgents, deriveTasks, EventBuffer, parseEventQuery, queryEvents } from './state.js';

export const DEFAULT_PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');

/** Links the UI shows in its header. */
export interface HubLinks {
  clawmetryUrl: string;
  shops: Array<{ id: string; name: string; url: string }>;
}

export interface HubOptions {
  host: string;
  /** 0 = pick a free port. */
  port: number;
  /** Directory of the daily JSONL journal. */
  eventsDir: string;
  links: HubLinks;
  publicDir?: string;
  capacity?: number;
  /**
   * Agents whose last recorded state may be stale after a restart (an agent that died without saying so).
   * Each one that is not stopped on the board and does not answer `alive` is recorded as stopped.
   */
  staleCheck?: { agents: readonly string[]; alive(agent: string): Promise<boolean> };
}

export interface HubHandle {
  url: string;
  port: number;
  close(): Promise<void>;
}

export async function startHub(opts: HubOptions): Promise<HubHandle> {
  const log = createLogger('hub');
  const buffer = new EventBuffer(opts.capacity ?? 20_000);
  const journal = new EventJournal(opts.eventsDir, log);
  buffer.push(await journal.loadToday());
  const startedAt = new Date().toISOString();
  if (opts.staleCheck) {
    const stopped = await staleAgents(buffer.all(), opts.staleCheck);
    buffer.push(stopped);
    journal.append(stopped);
  }

  // The hub listens on loopback only and must also refuse other Host names: a web page using DNS rebinding
  // would otherwise read the event stream (it holds the Telegram transcript and tool inputs).
  const hostAllowed = isLoopbackHostHeader;

  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    if (hostAllowed(req.headers.host)) return next();
    res.status(403).json({ error: 'Host not allowed' });
  });
  app.use(express.json({ limit: '5mb' }));

  app.post('/api/events', (req, res) => {
    const parsed = ObsEventBatch.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: z.prettifyError(parsed.error) });
      return;
    }
    const events = Array.isArray(parsed.data) ? parsed.data : [parsed.data];
    ingest(events);
    res.status(201).json({ accepted: events.length });
  });

  app.get('/api/events', (req, res) => {
    res.json({ events: queryEvents(buffer.all(), parseEventQuery(req.query)) });
  });

  app.get('/api/agents', (_req, res) => {
    res.json({ agents: deriveAgents(buffer.all()) });
  });

  app.get('/api/tasks', (_req, res) => {
    res.json({ tasks: deriveTasks(buffer.all()) });
  });

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, startedAt, events: buffer.size, clients: wss.clients.size, ...opts.links });
  });

  app.use(express.static(opts.publicDir ?? DEFAULT_PUBLIC_DIR));

  // JSON errors (malformed JSON, body too large) instead of Express's HTML page.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = (err as { status?: number }).status ?? 500;
    if (status >= 500) log.error({ err: errorMessage(err) }, 'request failed');
    res.status(status).json({ error: errorMessage(err) });
  });

  const server = createServer(app);
  const wss = new WebSocketServer({
    server,
    path: '/ws',
    // Browsers send Origin on WebSocket upgrades and CORS does not apply, so only same-origin pages may connect.
    verifyClient: ({ origin, req }: { origin: string; req: IncomingMessage }) => {
      if (!hostAllowed(req.headers.host)) return false;
      if (!origin) return true; // non-browser client
      try {
        return new URL(origin).host === req.headers.host;
      } catch {
        return false;
      }
    },
  });

  // ws re-emits the HTTP server's errors (EADDRINUSE on listen) here; without a listener that throws before
  // the listen() promise below can reject.
  wss.on('error', (err) => log.debug({ err: errorMessage(err) }, 'websocket server error'));

  function ingest(events: ObsEvent[]): void {
    buffer.push(events);
    journal.append(events);
    const frame = JSON.stringify({ type: 'events', events });
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(frame);
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  const url = `http://${opts.host.includes(':') ? `[${opts.host}]` : opts.host}:${port}`;
  log.info({ url, loadedEvents: buffer.size }, 'dashboard hub listening');

  return {
    url,
    port,
    close: async () => {
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await journal.flush();
    },
  };
}

/** Synthetic "stopped" status events for agents the board shows as running that do not answer any more. */
async function staleAgents(events: readonly ObsEvent[], check: NonNullable<HubOptions['staleCheck']>): Promise<ObsEvent[]> {
  const board = new Map(deriveAgents(events).map((a) => [a.agent, a.state]));
  const out: ObsEvent[] = [];
  for (const agent of check.agents) {
    const state = board.get(agent);
    if (state === undefined || state === 'stopped' || state === 'offline') continue;
    if (await check.alive(agent).catch(() => false)) continue;
    out.push({
      id: randomUUID(),
      ts: new Date().toISOString(),
      agent,
      kind: 'status',
      data: { state: 'stopped', detail: 'not running when the dashboard started' },
    });
  }
  return out;
}
