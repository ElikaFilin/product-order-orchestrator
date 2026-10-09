import { request } from 'node:http';
import net, { type AddressInfo } from 'node:net';
import type { AgentExecutor } from '@a2a-js/sdk/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildAgentCard, startA2AServer, type A2AServerHandle } from '../src/shared/a2a.js';

/** Raw request with a chosen Host header (fetch does not allow overriding it). */
function statusWithHost(url: string, host: string, method = 'GET'): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method, headers: { host, 'content-type': 'application/json' } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end(method === 'POST' ? JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'message/send', params: {} }) : undefined);
  });
}

describe('A2A server', () => {
  let server: A2AServerHandle;
  let base: string;
  const executed: string[] = [];

  beforeAll(async () => {
    const probe = net.createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const { port } = probe.address() as AddressInfo;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    base = `http://127.0.0.1:${port}`;
    const executor: AgentExecutor = {
      execute: async (rc) => void executed.push(rc.taskId),
      cancelTask: async () => {},
    };
    server = await startA2AServer({ card: buildAgentCard({ name: 'test', description: 'test', baseUrl: base, skills: [] }), executor, host: '127.0.0.1', port });
  });

  afterAll(async () => {
    await server?.close();
  });

  it('refuses requests that address it by a foreign Host name (DNS rebinding)', async () => {
    expect(await statusWithHost(`${base}/.well-known/agent-card.json`, 'rebind.attacker.example')).toBe(403);
    expect(await statusWithHost(`${base}/a2a/jsonrpc`, 'rebind.attacker.example:41002', 'POST')).toBe(403);
    expect(executed).toEqual([]);
    expect(await statusWithHost(`${base}/.well-known/agent-card.json`, new URL(base).host)).toBe(200);
    expect(await statusWithHost(`${base}/healthz`, `localhost:${new URL(base).port}`)).toBe(200);
  });
});
