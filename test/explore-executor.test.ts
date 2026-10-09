/**
 * Explore executor over real A2A JSON-RPC, with the LLM replaced by a scripted fake that calls the
 * agent's real in-process MCP tools (ask_user, update_product_list) through an in-memory MCP client.
 */
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import net, { type AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Client } from '@a2a-js/sdk/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ExploreExecutor, type AgentRunner } from '../src/agents/explore/executor.js';
import { defaultSkillFile, ProductList } from '../src/agents/explore/product-list.js';
import { agentHome } from '../src/config/agents.js';
import { env } from '../src/config/env.js';
import { Telemetry } from '../src/observability/telemetry.js';
import {
  artifactData,
  buildAgentCard,
  createA2AClient,
  dataOf,
  dataPart,
  makeMessage,
  Role,
  sendRequest,
  startA2AServer,
  TaskState,
  textOf,
  textPart,
  type A2AServerHandle,
  type Message,
  type Part,
  type Task,
} from '../src/shared/a2a.js';

const SHOP = 'karashynyard';
const KYIV_CUTLETS = 'Котлети по-київськи з індички, 900 г';

type RunnerInput = Parameters<AgentRunner>[0];
/** What the fake model does in one run; its return value is the model's structured output. */
type Script = (input: RunnerInput, tools: McpClient) => Promise<unknown>;

let script: Script;
const runs: RunnerInput[] = [];

const fakeRunner: AgentRunner = async (input) => {
  runs.push(input);
  const tools = await connectTools(input.mcpServers.explore);
  try {
    const output = await script(input, tools);
    return { structured: input.outputSchema.parse(output), text: '', costUsd: 0, sessionId: 'fake-session' };
  } finally {
    await tools.close();
  }
};

async function connectTools(server: McpServerConfig | undefined): Promise<McpClient> {
  if (server?.type !== 'sdk' || !('instance' in server)) throw new Error('expected the in-process "explore" MCP server');
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(serverSide);
  const client = new McpClient({ name: 'fake-model', version: '0.0.0' });
  await client.connect(clientSide);
  return client;
}

async function callTool(tools: McpClient, name: string, args: Record<string, unknown>): Promise<string> {
  const result = await tools.callTool({ name, arguments: args });
  const text = (result.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? '').join('');
  if (result.isError) throw new Error(`${name} failed: ${text}`);
  return text;
}

async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

describe('ExploreExecutor over A2A', () => {
  let dir: string;
  let skillFile: string;
  let server: A2AServerHandle;
  let client: Client;
  let telemetry: Telemetry;

  const send = async (parts: Part[], ids: { taskId?: string; contextId?: string } = {}): Promise<Task> => {
    const message: Message = makeMessage(Role.ROLE_USER, parts, ids);
    const reply = await client.sendMessage(sendRequest(message), { signal: AbortSignal.timeout(10_000) });
    if (!('status' in reply)) throw new Error('expected a Task reply');
    return reply;
  };

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'explore-executor-'));
    skillFile = path.join(dir, 'SKILL.md');
    telemetry = new Telemetry('explore');
    const port = await freePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    server = await startA2AServer({
      card: buildAgentCard({ name: 'Explore agent (test)', description: 'test', baseUrl, skills: [] }),
      executor: new ExploreExecutor(telemetry, fakeRunner, new ProductList(skillFile)),
      host: '127.0.0.1',
      port,
    });
    client = await createA2AClient(baseUrl);
  });

  beforeEach(async () => {
    await copyFile(defaultSkillFile(), skillFile);
    runs.length = 0;
  });

  afterAll(async () => {
    await server?.close();
    await telemetry?.shutdown();
    await rm(dir, { recursive: true, force: true });
  });

  it('select-products: asks via INPUT_REQUIRED, takes the answer on the same task, returns a canonical Selection', async () => {
    let question = '';
    let answerSeen = '';
    script = async (input, tools) => {
      // The question comes rendered from the skill's table in the task prompt; the model sends it unchanged.
      question = input.prompt.match(/word for word:\n"""\n([\s\S]*?)\n"""/)?.[1] ?? '';
      answerSeen = await callTool(tools, 'ask_user', { question });
      // The model read "1 - 2 / 6 / 1": rows with names copied sloppily and a repeated product.
      return {
        outcome: 'selected',
        items: [
          { row: 1, name: 'філе зі стегна індички, 1 кг', qty: 2 },
          { row: 6, name: 'Котлети з фермерської індички, 900 г', qty: 1 },
          { row: 1, name: 'Філе  зі стегна індички, 1 кг', qty: 1 },
        ],
      };
    };

    const request = { type: 'explore-request', action: 'select-products', shopId: SHOP };
    const asked = await send([textPart('The user wants to order. Ask what to buy.'), dataPart(request)]);

    expect(asked.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
    expect(question.split('\n').filter((l) => /^\d+\. /.test(l))).toHaveLength(21);
    expect(question).toContain('1. Філе зі стегна індички, 1 кг — ≈665 грн\n2. Стегно індички, 1 кг — ≈595 грн');
    expect(question).toContain('21. Горіхова паста з фунндуком 350 г — ≈850 грн');
    expect(textOf(asked.status?.message?.parts)).toBe(question);
    expect(dataOf(asked.status?.message?.parts)).toEqual([{ type: 'user-question', question }]);

    const done = await send([textPart('1 - 2\n6\n1')], { taskId: asked.id, contextId: asked.contextId });

    expect(answerSeen).toBe('1 - 2\n6\n1');
    expect(done.id).toBe(asked.id);
    expect(done.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(done.artifacts.map((a) => a.name)).toEqual(['selection']);
    expect(artifactData(done)).toEqual([
      {
        type: 'selection',
        shopId: SHOP,
        items: [
          { name: 'Філе зі стегна індички, 1 кг', qty: 3, sku: '1' },
          { name: 'Котлети з фермерської індички, 900 г', qty: 1, sku: '20' },
        ],
      },
    ]);

    // The model run is locked down to the skill and ask_user, in the agent's own home.
    const [run] = runs;
    expect(run).toMatchObject({
      agent: 'explore',
      model: env().EXPLORE_MODEL,
      cwd: agentHome('explore'),
      builtInTools: ['Skill'],
      skills: ['ask-what-to-buy'],
      settingSources: ['project'],
      allowedTools: ['Skill', 'mcp__explore__ask_user'],
      maxBudgetUsd: env().EXPLORE_MAX_BUDGET_USD,
    });
    expect(run?.systemPrompt).toContain('# Explore agent');
    expect(run?.prompt).toContain('select-products');
    expect(run?.prompt).toContain('The user wants to order.');
    expect(run?.guard?.('mcp__explore__update_product_list', {})?.deny).toBeTruthy();
    expect(run?.guard?.('Skill', { skill: 'other-skill' })?.deny).toBeTruthy();
    expect(run?.guard?.('Skill', { skill: 'ask-what-to-buy' })).toBeUndefined();
  });

  it('select-products with merge tells the model to read the added products from the message first', async () => {
    script = async (input) => {
      expect(input.prompt).toContain('Merge: the user adds products');
      expect(input.prompt).toContain('і ще 4');
      return { outcome: 'selected', items: [{ row: 4, name: 'Печінка індички, 500 г', qty: 1 }] };
    };
    const request = { type: 'explore-request', action: 'select-products', shopId: SHOP, merge: true };
    const done = await send([textPart('The user also wrote: і ще 4'), dataPart(request)]);
    expect(done.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(artifactData(done)).toEqual([{ type: 'selection', shopId: SHOP, items: [{ name: 'Печінка індички, 500 г', qty: 1, sku: '4' }] }]);
  });

  it('update-product-list: reports what the tool really changed, not what the model claims', async () => {
    script = async (input, tools) => {
      await callTool(tools, 'update_product_list', { shopId: SHOP, add: [KYIV_CUTLETS, 'Шиї курки, 1 кг'] });
      expect(input.allowedTools).toContain('mcp__explore__update_product_list');
      return { notes: 'Added 5 products and removed honey.' };
    };

    const request = { type: 'explore-request', action: 'update-product-list', shopId: SHOP, add: [KYIV_CUTLETS] };
    const done = await send([textPart(`save info - add "${KYIV_CUTLETS}" to product list selection`), dataPart(request)]);

    expect(done.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(done.artifacts.map((a) => a.name)).toEqual(['product-list-update']);
    const [update] = artifactData(done) as Array<{ added: string[]; removed: string[]; products: string[] }>;
    expect(update).toMatchObject({ type: 'product-list-update', shopId: SHOP, added: [KYIV_CUTLETS], removed: [] });
    expect(update?.products).toHaveLength(22);
    expect(update?.products.at(-1)).toBe(KYIV_CUTLETS);
    expect(textOf(done.status?.message?.parts)).toContain('already listed: Шиї курки, 1 кг');
    expect(await readFile(skillFile, 'utf8')).toContain(`| 22 | ${KYIV_CUTLETS} |`);
  });

  it('defaults to select-products in the default shop and ends CANCELED when the user wants nothing', async () => {
    script = async (input, tools) => {
      expect(input.prompt).toContain(`"${env().DEFAULT_SHOP}"`);
      await callTool(tools, 'ask_user', { question: 'Що замовити?' });
      return { outcome: 'canceled', items: [] };
    };

    const asked = await send([textPart('хочу замовити')]);
    expect(asked.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);

    const done = await send([textPart('нічого, скасуй')], { taskId: asked.id, contextId: asked.contextId });

    expect(done.status?.state).toBe(TaskState.TASK_STATE_CANCELED);
    expect(textOf(done.status?.message?.parts)).toContain('The user chose not to buy anything.');
    expect(done.artifacts).toEqual([]);
  });

  it('fails a malformed explore-request instead of guessing', async () => {
    script = async () => {
      throw new Error('the model must not run');
    };
    const done = await send([dataPart({ type: 'explore-request', action: 'select-products' })]);

    expect(done.status?.state).toBe(TaskState.TASK_STATE_FAILED);
    expect(dataOf(done.status?.message?.parts)).toMatchObject([{ type: 'error', code: 'INVALID_REQUEST' }]);
    expect(runs).toHaveLength(0);
  });
});
