import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ROOT_DIR } from '../../src/config/env.js';
import { skillFile } from '../../src/core/explore/product-list.js';
import { karashynyard } from '../../src/core/shops/karashynyard/index.js';
import { parsePluginConfig } from '../../src/plugin/config.js';
import { setupPlugin } from '../../src/plugin/plugin.js';
import { createRuntime, type Runtime } from '../../src/plugin/runtime.js';
import { child, COS, FakeHost, pageResult, textResult } from './fake-host.js';

const FILLET = 'Філе зі стегна індички, 1 кг';
const THIGH = 'Стегно індички, 1 кг';
const PW = 'playwright__';

let dir: string;
let host: FakeHost;
let rt: Runtime;

function start(extra: Record<string, unknown> = {}): void {
  host = new FakeHost();
  const config = parsePluginConfig({
    skillFile: path.join(dir, 'SKILL.md'),
    telegramUserId: '4242',
    browserMode: 'cdp',
    stateFile: path.join(dir, 'state', 'state.json'),
    ...extra,
  });
  rt = setupPlugin(host, createRuntime(config, host.logger));
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'poo-plugin-'));
  await copyFile(skillFile(ROOT_DIR), path.join(dir, 'SKILL.md'));
  start();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** COS creates a task and spawns it; the gateway binds a child session to it. Returns the task id and rewritten spawn params. */
async function spawn(agent: 'explore' | 'execute' | 'qa', args: Record<string, unknown> = {}, n = 1) {
  const created = await host.tool('poo_task', { agent, instruction: '', ...args }, COS);
  expect(created).toMatchObject({ agent, state: 'created' });
  const before = await host.before('sessions_spawn', { agentId: agent, task: created.taskId }, COS);
  expect(before.block).toBeUndefined();
  const c = child(agent, n);
  await host.emit('subagent_spawned', { childSessionKey: c.sessionKey, agentId: agent, label: String(before.params!.label), runId: c.runId }, {});
  await host.result('sessions_spawn', before.params!, textResult(JSON.stringify({ status: 'accepted', childSessionKey: c.sessionKey, runId: c.runId })), COS, before.toolCallId);
  return { taskId: created.taskId as string, params: before.params!, ctx: c };
}

/** A child asks, COS relays and stores the answer, and sessions_send carries it back. Returns the message the child gets. */
async function askAndAnswer(taskId: string, ctx: ReturnType<typeof child>, question: string, answer: string) {
  expect(await host.tool('poo_ask_user', { question }, ctx)).toMatch(/End your run/);
  const relay = await host.before('message', { action: 'send', message: `@relay:${taskId}` }, COS);
  expect(relay.params).toEqual({ action: 'send', message: question });
  await host.result('message', relay.params!, textResult('{"ok":true}'), COS, relay.toolCallId);
  const stored = await host.tool('poo_answer', { taskId, answer }, COS);
  expect(stored.state).toBe('answered');
  expect(stored.next).toContain(ctx.sessionKey);
  const send = await host.before('sessions_send', { sessionKey: ctx.sessionKey, message: `answer:${taskId}`, timeoutSeconds: 5 }, COS);
  expect(send.block).toBeUndefined();
  return send;
}

describe('a whole order through the plugin', () => {
  it('selects, fills, verifies and only then sends the basket link', async () => {
    // Explore: the plugin writes the task text with the product question rendered from the skill table.
    const explore = await spawn('explore');
    expect(explore.params).toMatchObject({ agentId: 'explore', mode: 'run', cleanup: 'keep', completionTarget: 'parent', runTimeoutSeconds: 300 });
    expect(String(explore.params.task)).toContain(`1. ${FILLET} — ≈665 грн`);
    expect(String(explore.params.task)).toContain('poo_ask_user word for word');

    const question = String(explore.params.task).match(/"""\n([\s\S]*?)\n"""/)![1]!;
    const send = await askAndAnswer(explore.taskId, explore.ctx, question, '1 - 2\n2');
    expect(send.params).toMatchObject({ sessionKey: explore.ctx.sessionKey, timeoutSeconds: 300 });
    expect(String(send.params!.message)).toContain('"""\n1 - 2\n2\n"""');

    // The continued run submits rows; the plugin maps them to the exact table names.
    expect(await host.tool('poo_submit_selection', { outcome: 'selected', items: [{ row: 1, name: 'філе', qty: 2 }, { row: 2, name: THIGH, qty: 1 }] }, explore.ctx)).toMatch(/Submitted/);
    const sent = await host.result('sessions_send', send.params!, textResult(JSON.stringify({ status: 'ok', reply: 'Selected 2 products.' })), COS, send.toolCallId);
    const report = JSON.parse((sent.content[0] as { text: string }).text);
    expect(report).toMatchObject({ state: 'completed', reply: 'Selected 2 products.', selection: [{ name: FILLET, qty: 2 }, { name: THIGH, qty: 1 }] });
    expect(report.next).toContain('poo_task {"agent":"execute"}');

    // The link cannot go out yet.
    expect((await host.before('message', { action: 'send', message: 'Готово: {{cart_link}}' }, COS)).block).toBe(true);
    expect((await host.before('message', { action: 'send', message: 'Ось: https://karashynyard.com.ua/#opencart' }, COS)).block).toBe(true);

    // Execute: the guard rewrites page scripts and the plugin captures what the page returned.
    const execute = await spawn('execute');
    expect(String(execute.params.task)).toContain(`${PW}browser_tabs`);
    expect(String(execute.params.task)).toContain('poo_submit_execute');
    const x = execute.ctx;
    expect((await host.before(`${PW}browser_evaluate`, { function: '() => window.__poo.status()' }, x)).block).toBe(true); // own tab first
    expect((await host.before(`${PW}browser_tabs`, { action: 'new', url: karashynyard.baseUrl }, x)).block).toBeUndefined();
    for (const [name, qty, after] of [[FILLET, 2, 2], [THIGH, 1, 1]] as const) {
      const call = await host.before(`${PW}browser_evaluate`, { function: `() => window.__poo.setQty(${JSON.stringify(name)}, ${qty})` }, x);
      expect(String(call.params!.function)).toContain('window.__poo');
      expect(String(call.params!.function)).toContain('not on the shop');
      await host.result(`${PW}browser_evaluate`, call.params!, pageResult({ status: 'ok', name, before: 0, after }), x, call.toolCallId);
    }
    const read = await host.before(`${PW}browser_evaluate`, { function: '() => window.__poo.readCart()' }, x);
    await host.result(`${PW}browser_evaluate`, read.params!, pageResult({ lines: [{ name: FILLET, qty: 2 }, { name: THIGH, qty: 1 }], total: 1925 }), x, read.toolCallId);
    // The model claims a wrong quantity; the page data wins.
    await host.tool('poo_submit_execute', { ops: [{ name: FILLET, targetQty: 2, status: 'ok', actualQty: 3 }, { name: THIGH, targetQty: 1, status: 'ok' }], cart: [] }, x);
    const executed = await host.tool('poo_task_status', { taskId: execute.taskId }, COS);
    expect(executed.operations).toEqual([
      expect.objectContaining({ name: FILLET, status: 'ok', actualQty: 2 }),
      expect.objectContaining({ name: THIGH, status: 'ok', actualQty: 1 }),
    ]);
    expect(executed.next).toContain('poo_task {"agent":"qa"}');
    await host.emit('subagent_ended', { targetSessionKey: x.sessionKey, reason: 'subagent-complete', outcome: 'ok', runId: x.runId }, {});

    // QA: read-only, clicks the basket icon, the verdict comes from the page.
    const qa = await spawn('qa');
    const q = qa.ctx;
    await host.before(`${PW}browser_tabs`, { action: 'new', url: karashynyard.baseUrl }, q);
    expect((await host.before(`${PW}browser_evaluate`, { function: `() => window.__poo.setQty(${JSON.stringify(FILLET)}, 5)` }, q)).blockReason).toMatch(/read-only/);
    expect((await host.before(`${PW}browser_click`, { target: '.t706__product-del', element: 'x' }, q)).blockReason).toMatch(/basket icon/);
    expect((await host.before(`${PW}browser_click`, { target: '.t706__carticon-wrapper', element: 'cart icon' }, q)).block).toBeUndefined();
    const modal = await host.before(`${PW}browser_evaluate`, { function: '() => window.__poo.readModal()' }, q);
    await host.result(`${PW}browser_evaluate`, modal.params!, pageResult({ open: true, lines: [{ name: FILLET, qty: 2, amount: 1330 }, { name: THIGH, qty: 1, amount: 595 }], total: 1925 }), q, modal.toolCallId);
    await host.tool('poo_submit_qa', { modalOpened: true, readVia: 'modal', lines: [{ name: FILLET, qty: 2 }], total: 1925 }, q);
    const verified = await host.tool('poo_task_status', { taskId: qa.taskId }, COS);
    expect(verified).toMatchObject({ verdict: 'match', modalOpened: true, differences: [] });
    expect(verified.next).toContain('{{cart_link}}');
    expect(rt.store.order.isVerified()).toBe(true);

    // Now the link goes out, written by the plugin.
    const final = await host.before('message', { action: 'send', message: 'Кошик готовий: {{cart_link}}' }, COS);
    expect(final.params).toEqual({ action: 'send', message: `Кошик готовий: ${karashynyard.cartUrl}` });
    expect(await host.emit('message_sending', { to: 'telegram:4242', content: final.params!.message as string }, { channelId: 'telegram' })).toEqual([undefined]);
  });

  it('a mismatch leads to a fix and a focused re-check', async () => {
    rt.store.update(() => rt.store.order.applySelection({ type: 'selection', shopId: 'karashynyard', items: [{ name: FILLET, qty: 2 }] }));
    const qa = await spawn('qa');
    await host.tool('poo_submit_qa', { modalOpened: true, readVia: 'modal', lines: [{ name: FILLET, qty: 2 }, { name: THIGH, qty: 1 }], total: null }, qa.ctx);
    const mismatch = await host.tool('poo_task_status', { taskId: qa.taskId }, COS);
    expect(mismatch.differences).toEqual([{ kind: 'extra', name: THIGH, expectedQty: 0, actualQty: 1 }]);
    expect(mismatch.next).toContain('"action":"fix"');

    const fix = await host.tool('poo_task', { agent: 'execute', action: 'fix', instruction: 'прибери зайве', ops: [{ name: THIGH, targetQty: 0 }] }, COS);
    expect(fix.state).toBe('created');
    rt.store.update(() => rt.store.order.applyExecuteResult({ type: 'execute-result', shopId: 'karashynyard', cartUrl: '', ops: [{ name: THIGH, targetQty: 0, status: 'ok' }], cart: [] }, 'fix'));
    rt.store.update(() => rt.store.touch(rt.store.task(fix.taskId)!, { state: 'completed' }));
    const recheck = await spawn('qa', {}, 2);
    expect(String(recheck.params.task)).toContain(`"${THIGH}": must no longer be in the basket`);
  });
});

describe('questions and answers', () => {
  it('needs a relayed question before an answer, and delivers the answer only to the asking session', async () => {
    const explore = await spawn('explore');
    await host.tool('poo_ask_user', { question: 'Скільки?' }, explore.ctx);
    await expect(host.tool('poo_answer', { taskId: explore.taskId, answer: '2' }, COS)).rejects.toThrow(/relay it first/);
    expect((await host.before('sessions_send', { sessionKey: explore.ctx.sessionKey, message: 'hi' }, COS)).blockReason).toMatch(/input-required/);
    expect((await host.before('sessions_send', { sessionKey: 'agent:cos:main', message: 'hi' }, COS)).blockReason).toMatch(/sessionKey of the task/);
    expect((await host.before('message', { action: 'send', message: '@relay:explore-00000000' }, COS)).blockReason).toMatch(/No question waits/);
    expect((await host.before('message', { action: 'send', message: `see @relay:${explore.taskId}` }, COS)).blockReason).toMatch(/alone/);
  });

  it('shows COS the pending question with when it arrived and when it was relayed', async () => {
    const explore = await spawn('explore');
    await host.tool('poo_ask_user', { question: 'Скільки?' }, explore.ctx);
    let context = (await host.promptBuild(COS))!.appendContext!;
    expect(context).toMatch(new RegExp(`taskId=${explore.taskId} agent=explore received_at=\\S+ \\(not sent to the user yet\\)`));
    const relay = await host.before('message', { action: 'send', message: `@relay:${explore.taskId}` }, COS);
    await host.result('message', relay.params!, textResult('{}'), COS, relay.toolCallId);
    context = (await host.promptBuild(COS))!.appendContext!;
    expect(context).toMatch(/relayed_at=\S+/);
    expect(context).toContain('question: Скільки?');
  });

  it('keeps an undelivered answer and continues the task in a new session that replays the question and answer', async () => {
    const explore = await spawn('explore');
    const send = await askAndAnswer(explore.taskId, explore.ctx, 'Скільки філе?', '3');
    const failed = await host.result('sessions_send', send.params!, textResult(JSON.stringify({ status: 'error', error: 'session archived' })), COS, send.toolCallId, true);
    const report = JSON.parse((failed.content[0] as { text: string }).text);
    expect(report).toMatchObject({ state: 'answered', sessions_send: 'error' });
    expect(report.next).toContain('sessions_spawn');

    const respawn = await host.before('sessions_spawn', { agentId: 'explore', task: explore.taskId }, COS);
    expect(respawn.params!.label).toBe(`poo-${explore.taskId}-2`);
    expect(String(respawn.params!.task)).toContain('You asked the user:\n"""\nСкільки філе?\n"""\nThe user answered:\n"""\n3\n"""');
  });
});

describe('task lifecycle', () => {
  it('fails a run that ended without a result, cancels a killed one', async () => {
    rt.store.update(() => rt.store.order.applySelection({ type: 'selection', shopId: 'karashynyard', items: [{ name: FILLET, qty: 1 }] }));
    const execute = await spawn('execute');
    await host.emit('subagent_ended', { targetSessionKey: execute.ctx.sessionKey, reason: 'subagent-complete', outcome: 'ok', runId: execute.ctx.runId }, {});
    expect(rt.store.task(execute.taskId)).toMatchObject({ state: 'failed', error: { code: 'LLM_ERROR' } });

    const qa = await spawn('qa');
    await host.emit('subagent_ended', { targetSessionKey: qa.ctx.sessionKey, reason: 'killed', outcome: 'killed', runId: qa.ctx.runId }, {});
    expect(rt.store.task(qa.taskId)?.state).toBe('canceled');
  });

  it('runs one task per agent, and never Execute and QA at the same time', async () => {
    rt.store.update(() => rt.store.order.applySelection({ type: 'selection', shopId: 'karashynyard', items: [{ name: FILLET, qty: 1 }] }));
    const execute = await spawn('execute');
    await expect(host.tool('poo_task', { agent: 'qa', instruction: '' }, COS)).rejects.toThrow(new RegExp(`${execute.taskId}.*running`));
    await expect(host.tool('poo_task', { agent: 'execute', instruction: '' }, COS)).rejects.toThrow(/one task per agent/);
    expect(await host.tool('poo_cancel', { taskId: execute.taskId }, COS)).toContain(`"runId":"${execute.ctx.runId}"`);
    expect((await host.tool('poo_task', { agent: 'qa', instruction: '' }, COS)).state).toBe('created');
  });

  it('completes an update-product-list task with the applied changes, and the next question lists the product', async () => {
    const update = await spawn('explore', { action: 'update-product-list', add: ['Нова паста 200 г'] });
    expect(String(update.params.task)).toContain('Add: ["Нова паста 200 г"]');
    const changed = await host.tool('poo_update_product_list', { add: ['Нова паста 200 г'] }, update.ctx);
    expect(changed.added).toEqual(['Нова паста 200 г']);
    await host.emit('subagent_ended', { targetSessionKey: update.ctx.sessionKey, reason: 'subagent-complete', outcome: 'ok', runId: update.ctx.runId }, {});
    expect(await host.tool('poo_task_status', { taskId: update.taskId }, COS)).toMatchObject({ state: 'completed', productList: { added: ['Нова паста 200 г'] } });
    expect(await readFile(path.join(dir, 'SKILL.md'), 'utf8')).toContain('Нова паста 200 г');

    const select = await spawn('explore', {}, 2);
    expect(String(select.params.task)).toMatch(/\d+\. Нова паста 200 г/);
  });

  it('keeps the order and the tasks across a gateway restart', async () => {
    const explore = await spawn('explore');
    await host.tool('poo_ask_user', { question: 'Скільки?' }, explore.ctx);
    const orderId = rt.store.order.orderId;
    start();
    expect(rt.store.order.orderId).toBe(orderId);
    expect(rt.store.task(explore.taskId)).toMatchObject({ state: 'input-required', childSessionKey: explore.ctx.sessionKey });
    expect((await host.before('message', { action: 'send', message: `@relay:${explore.taskId}` }, COS)).params!.message).toBe('Скільки?');
  });

  it('/new resets the order and cancels its tasks', async () => {
    rt.store.update(() => rt.store.order.applySelection({ type: 'selection', shopId: 'karashynyard', items: [{ name: FILLET, qty: 1 }] }));
    const execute = await spawn('execute');
    const orderId = rt.store.order.orderId;
    await host.emit('before_reset', { reason: 'new' }, COS);
    expect(rt.store.order.orderId).not.toBe(orderId);
    expect(rt.store.order.expectedItems()).toEqual([]);
    expect(rt.store.task(execute.taskId)?.state).toBe('canceled');
  });
});
