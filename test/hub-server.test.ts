import { request } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net, { type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { resetEnvCache, runtimeDir } from '../src/config/env.js';
import type { ObsEvent } from '../src/observability/events.js';
import { startHub, type HubHandle } from '../src/observability/hub/hub.js';
import { localDate } from '../src/observability/hub/journal.js';

const links = { clawmetryUrl: 'http://127.0.0.1:8900', shops: [{ id: 'shop', name: 'Shop', url: 'https://shop.example' }] };

function event(agent: string, kind: ObsEvent['kind'], data: Record<string, unknown>, extra: Partial<ObsEvent> = {}): ObsEvent {
  return { id: crypto.randomUUID(), ts: new Date().toISOString(), agent, kind, data, ...extra };
}

/** Raw GET with a custom Host header (fetch does not allow overriding it). */
function getWithHost(url: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(url, { headers: { host } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

function openSocket(url: string, origin?: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, origin ? { origin } : {});
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

describe('dashboard hub server', () => {
  let tmp: string;
  let eventsDir: string;
  let hub: HubHandle;

  beforeAll(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), 'poo-hub-'));
    process.env.RUNTIME_DIR = tmp;
    resetEnvCache();
    eventsDir = runtimeDir('events');
    hub = await startHub({ host: '127.0.0.1', port: 0, eventsDir, links });
  });

  afterAll(async () => {
    await hub?.close();
    delete process.env.RUNTIME_DIR;
    resetEnvCache();
    await rm(tmp, { recursive: true, force: true });
  });

  it('accepts a batch, broadcasts it over the WebSocket, and serves filtered queries and derived views', async () => {
    const ws = await openSocket(`ws://127.0.0.1:${hub.port}/ws`);
    const frame = new Promise<{ type: string; events: ObsEvent[] }>((resolve) =>
      ws.once('message', (data) => resolve(JSON.parse(String(data)))),
    );

    const ids = { taskId: 'task-1', contextId: 'ctx-1' };
    const batch = [
      event('explore', 'status', { state: 'busy', detail: 'asking' }, ids),
      event('explore', 'a2a', { direction: 'send', to: 'cos', state: 'input-required', text: 'Which?' }, ids),
      event('explore', 'tool_call', { tool: 'mcp__explore__ask_user', toolUseId: 'u1' }, ids),
      event('qa', 'run', { costUsd: 0.2 }, { sessionId: 's1' }),
    ];
    const res = await fetch(`${hub.url}/api/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(batch),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ accepted: 4 });

    const pushed = await frame;
    expect(pushed.type).toBe('events');
    expect(pushed.events.map((e) => e.id)).toEqual(batch.map((e) => e.id));
    ws.close();

    // A single event (not an array) is accepted too.
    const single = event('cos', 'telegram', { direction: 'in', text: 'хочу замовити' });
    expect((await fetch(`${hub.url}/api/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(single) })).status).toBe(201);

    const filtered = (await (await fetch(`${hub.url}/api/events?agent=explore&kind=tool_call,a2a`)).json()) as { events: ObsEvent[] };
    expect(filtered.events.map((e) => e.kind)).toEqual(['a2a', 'tool_call']);
    const byContext = (await (await fetch(`${hub.url}/api/events?contextId=ctx-1&limit=1`)).json()) as { events: ObsEvent[] };
    expect(byContext.events.map((e) => e.kind)).toEqual(['tool_call']);

    const { agents } = (await (await fetch(`${hub.url}/api/agents`)).json()) as { agents: Array<Record<string, unknown>> };
    expect(agents.find((a) => a.agent === 'explore')).toMatchObject({ state: 'busy', taskId: 'task-1', toolCalls: 1 });
    expect(agents.find((a) => a.agent === 'qa')).toMatchObject({ costUsd: 0.2 });

    const { tasks } = (await (await fetch(`${hub.url}/api/tasks`)).json()) as { tasks: Array<Record<string, unknown>> };
    expect(tasks).toEqual([expect.objectContaining({ taskId: 'task-1', agent: 'explore', state: 'input-required' })]);

    const health = (await (await fetch(`${hub.url}/api/health`)).json()) as Record<string, unknown>;
    expect(health).toMatchObject({ ok: true, events: 5, clawmetryUrl: links.clawmetryUrl, shops: links.shops });
  });

  it('rejects invalid payloads with 400 and a JSON error', async () => {
    const invalid = await fetch(`${hub.url}/api/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: 'cos', kind: 'nonsense' }),
    });
    expect(invalid.status).toBe(400);
    expect(((await invalid.json()) as { error: string }).error).toMatch(/id|kind/);

    const malformed = await fetch(`${hub.url}/api/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toHaveProperty('error');
  });

  it('refuses foreign Host headers and cross-origin WebSocket clients', async () => {
    expect(await getWithHost(`${hub.url}/api/events`, 'evil.example:41010')).toBe(403);
    expect(await getWithHost(`${hub.url}/api/health`, `localhost:${hub.port}`)).toBe(200);
    await expect(openSocket(`ws://127.0.0.1:${hub.port}/ws`, 'https://evil.example')).rejects.toThrow();
    const sameOrigin = await openSocket(`ws://127.0.0.1:${hub.port}/ws`, hub.url);
    sameOrigin.close();
  });

  it('serves the dashboard UI', async () => {
    const res = await fetch(`${hub.url}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Product Order Orchestrator — Agents');
    expect((await fetch(`${hub.url}/app.js`)).status).toBe(200);
  });

  it("persists events to today's JSONL journal and reloads them after a restart", async () => {
    await hub.close();
    const journal = await readFile(path.join(eventsDir, `${localDate()}.jsonl`), 'utf8');
    expect(journal.trim().split('\n')).toHaveLength(5);

    hub = await startHub({ host: '127.0.0.1', port: 0, eventsDir, links });
    const { events } = (await (await fetch(`${hub.url}/api/events`)).json()) as { events: ObsEvent[] };
    expect(events).toHaveLength(5);
  });
});

describe('dashboard hub start', () => {
  it('records agents that are not running any more as stopped (a run that ended without saying so)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'poo-hub-stale-'));
    try {
      const journal = [
        event('explore', 'status', { state: 'idle', detail: 'ready' }),
        event('qa', 'status', { state: 'waiting_input', detail: 'Which one?' }, { taskId: 't1' }),
        event('execute', 'status', { state: 'idle', detail: 'ready' }),
        event('cos', 'status', { state: 'idle', detail: 'ready' }),
      ];
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, `${localDate()}.jsonl`), journal.map((e) => JSON.stringify(e)).join('\n'));
      const probed: string[] = [];
      const staleHub = await startHub({
        host: '127.0.0.1',
        port: 0,
        eventsDir: dir,
        links,
        staleCheck: { agents: ['explore', 'execute', 'qa'], alive: async (agent) => (probed.push(agent), agent === 'execute') },
      });
      try {
        const { agents } = (await (await fetch(`${staleHub.url}/api/agents`)).json()) as { agents: Array<{ agent: string; state: string; detail?: string }> };
        const state = (name: string) => agents.find((a) => a.agent === name);
        expect(probed.sort()).toEqual(['execute', 'explore', 'qa']);
        expect(state('explore')).toMatchObject({ state: 'stopped', detail: 'not running when the dashboard started' });
        expect(state('qa')?.state).toBe('stopped');
        expect(state('execute')?.state).toBe('idle');
        expect(state('cos')?.state).toBe('idle');
      } finally {
        await staleHub.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects with EADDRINUSE when the port is taken, without crashing the process', async () => {
    const holder = net.createServer();
    await new Promise<void>((resolve) => holder.listen(0, '127.0.0.1', resolve));
    const { port } = holder.address() as AddressInfo;
    try {
      await expect(startHub({ host: '127.0.0.1', port, eventsDir: path.join(tmpdir(), 'poo-hub-busy'), links })).rejects.toMatchObject({ code: 'EADDRINUSE' });
    } finally {
      await new Promise<void>((resolve) => holder.close(() => resolve()));
    }
  });
});
