/**
 * Scripted "models" for the four agents behind the mock Anthropic API. Each request is answered from its own body
 * only: the agent is recognised by its AGENTS.md heading in the system prompt, and the next step is derived by
 * replaying the agent's script over the tool calls and tool results already in the conversation. So the mock acts
 * like a model that reads what its tools returned (the plugin's `next` steps, the skill's product table, page
 * results) instead of following a fixed list of replies.
 */
import type { MockReply, PolicyResult } from './mock-anthropic.js';

export type AgentKind = 'cos' | 'explore' | 'execute' | 'qa';

/** Scenario D: every agent also tries what it must never do; each attempt must come back as a refused call. */
export interface Probes {
  forbidden: boolean;
}

export const PROBE = {
  cosCartLink: 'Ось кошик: {{cart_link}}',
  cosWrite: 'AGENTS.md',
  exploreRead: '../../.env',
  executeNavigate: 'https://example.com/',
  executeFreeJs: '() => document.title',
  executeOrderForm: '() => window.__poo.find("Відправити замовлення")',
  qaWrite: '() => window.__poo.setQty("Філе зі стегна індички, 1 кг", 5)',
  qaMessage: 'QA tries to talk to the user',
} as const;

interface Block {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

export interface ToolResult {
  text: string;
  isError: boolean;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  msgIndex: number;
  result?: ToolResult;
}

const blocksOf = (content: unknown): Block[] =>
  typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? (content as Block[]) : [];
const textOf = (content: unknown): string =>
  blocksOf(content)
    .map((b) => (b.type === 'text' ? (b.text ?? '') : ''))
    .join('\n');

export class Conversation {
  readonly system: string;
  readonly tools: string[];
  readonly messages: Array<{ role: string; blocks: Block[] }>;
  readonly calls: ToolCall[] = [];

  constructor(body: Record<string, unknown>) {
    this.system = textOf(body.system);
    this.tools = ((body.tools as Array<{ name?: string }> | undefined) ?? []).map((t) => String(t.name));
    this.messages = ((body.messages as Array<{ role: string; content: unknown }> | undefined) ?? []).map((m) => ({ role: m.role, blocks: blocksOf(m.content) }));
    const byId = new Map<string, ToolCall>();
    this.messages.forEach((m, msgIndex) => {
      for (const b of m.blocks) {
        if (m.role === 'assistant' && b.type === 'tool_use' && b.id && b.name) {
          const call: ToolCall = { id: b.id, name: b.name, input: (b.input ?? {}) as Record<string, unknown>, msgIndex };
          byId.set(b.id, call);
          this.calls.push(call);
        } else if (m.role === 'user' && b.type === 'tool_result' && b.tool_use_id) {
          const call = byId.get(b.tool_use_id);
          if (call) call.result = { text: textOf(b.content), isError: b.is_error === true };
        }
      }
    });
  }

  agent(): AgentKind | undefined {
    if (/(^|\n)# Chief of Staff \(COS\)\n/.test(this.system)) return 'cos';
    if (/(^|\n)# Explore agent\n/.test(this.system)) return 'explore';
    if (/(^|\n)# Execute agent\n/.test(this.system)) return 'execute';
    if (/(^|\n)# QA agent\n/.test(this.system)) return 'qa';
    return undefined;
  }

  userText(index: number): string {
    const m = this.messages[index];
    return m && m.role === 'user' ? m.blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n') : '';
  }

  /**
   * The user messages that started the current run (a message, a completion event or the task, plus the internal
   * context OpenClaw adds as a separate message): the last run of consecutive user messages with text.
   */
  turn(): { first: number; last: number } {
    let last = this.messages.length - 1;
    while (last >= 0 && !this.userText(last).trim()) last--;
    let first = last;
    while (first > 0 && this.messages[first - 1]!.role === 'user' && this.userText(first - 1).trim()) first--;
    return { first, last };
  }

  turnTexts(): string[] {
    const { first, last } = this.turn();
    const out: string[] = [];
    for (let i = Math.max(first, 0); i <= last; i++) out.push(this.userText(i));
    return out;
  }

  turnCalls(): ToolCall[] {
    const { last } = this.turn();
    return this.calls.filter((c) => c.msgIndex > last);
  }

  firstUserText(): string {
    const i = this.messages.findIndex((m) => m.role === 'user');
    return i < 0 ? '' : this.userText(i);
  }

  /** User texts after message `index` that contain `fragment`. */
  laterTexts(index: number, fragment: string): string[] {
    const out: string[] = [];
    for (let i = index + 1; i < this.messages.length; i++) {
      const t = this.userText(i);
      if (t.includes(fragment)) out.push(t);
    }
    return out;
  }
}

/** Thrown to hand the next model output back to the mock server. */
class NextReply {
  constructor(readonly reply: MockReply) {}
}

/** Replays a sequential agent script over the tool calls already in the conversation. */
export class Replay {
  private i = 0;

  constructor(
    private readonly agent: string,
    private readonly calls: readonly ToolCall[],
  ) {}

  call(name: string, input: Record<string, unknown>, text?: string): ToolResult {
    const c = this.calls[this.i];
    if (!c) throw new NextReply({ kind: 'tool_use', name, input, ...(text ? { text } : {}) });
    this.i += 1;
    if (c.name !== name) throw new Error(`${this.agent} script diverged at call ${this.i}: script wants ${name}, the conversation has ${c.name}`);
    if (!c.result) throw new Error(`${this.agent}: no tool_result for ${c.name} (${c.id})`);
    return c.result;
  }

  end(text: string): never {
    if (this.i < this.calls.length) throw new Error(`${this.agent} script ended after ${this.i} calls but the conversation has ${this.calls.length}`);
    throw new NextReply({ kind: 'text', text });
  }
}

// ---------- helpers ----------

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export const json = (r: ToolResult): Record<string, any> => {
  const v = tryJson(r.text);
  if (!v || typeof v !== 'object') throw new Error(`expected a JSON tool result, got: ${r.text.slice(0, 300)}`);
  return v as Record<string, any>;
};

/** The value a page script returned, from a Playwright MCP tool result. */
export function pageValue(text: string): unknown {
  const section = text.match(/### Result\s*\n([\s\S]*?)(?:\n### |$)/);
  return tryJson((section ? section[1]! : text).trim());
}

export interface Product {
  n: number;
  name: string;
  sku: string;
  price: string;
}

export function parseProductTable(text: string, shopId: string): Product[] {
  const start = text.indexOf(`<!-- products:${shopId}:start -->`);
  const end = text.indexOf(`<!-- products:${shopId}:end -->`, start);
  if (start < 0 || end < 0) throw new Error(`no product table for ${shopId} in the skill text`);
  return text
    .slice(start, end)
    .split('\n')
    .map((l) => l.replace(/^\s*\d+[→\t|:]\s?/, '').trim()) // tolerate line-numbered read output
    .filter((l) => /^\|\s*\d+\s*\|/.test(l))
    .map((l) => {
      const [n, name, sku, price] = l.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      return { n: Number(n), name: name ?? '', sku: sku ?? '', price: price ?? '' };
    });
}

export const QUESTION_HEAD =
  'Що замовити? Напишіть номер товару і кількість, кожен товар з нового рядка, у форматі «номер - кількість». Без кількості = 1 шт.';

export interface Item {
  name: string;
  qty: number;
}

export function productQuestion(products: readonly Product[], standing: readonly Item[] = []): string {
  const always = standing.length
    ? [`Завжди додається до замовлення: ${standing.map((i) => `${i.name} × ${i.qty}`).join('; ')}. Якщо більше нічого не треба, напишіть «0».`]
    : [];
  return [QUESTION_HEAD, ...always, 'Наприклад:', '1 - 2', '5', '', ...products.map((p) => `${p.n}. ${p.name}${p.price ? ` — ≈${p.price} грн` : ''}`)].join('\n');
}

/** "- <name> × <qty>" lines of a "## Every order" section (COS's MEMORY.md in its system prompt). */
function everyOrder(text: string): Item[] {
  const section = text.match(/(?:^|\n)## Every order\n([\s\S]*?)(?:\n## |$)/)?.[1] ?? '';
  return [...section.matchAll(/^- (.+) × (\d+)$/gm)].map((m) => ({ name: m[1]!, qty: Number(m[2]) }));
}

/** The skill's answer format: "N - Q", "N x Q", "N" (= 1); lines, commas and semicolons separate items. */
export function parseSelection(answer: string, products: readonly Product[]): Array<{ row: number; name: string; qty: number }> {
  const out = new Map<string, { row: number; name: string; qty: number }>();
  for (const raw of answer.split(/[\n,;]/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^(\d+)\s*(?:[-–x×х*:]\s*(\d+))?\s*(?:шт\.?)?$/i);
    if (!m) throw new Error(`scripted explore cannot read the answer line "${line}"`);
    const product = products.find((p) => p.n === Number(m[1]));
    if (!product) throw new Error(`scripted explore: no product number ${m[1]}`);
    const qty = m[2] ? Number(m[2]) : 1;
    const seen = out.get(product.name);
    if (seen) seen.qty += qty;
    else out.set(product.name, { row: product.n, name: product.name, qty });
  }
  return [...out.values()];
}

/** What a submit tool asks the child to end with. */
const summaryOf = (r: ToolResult) => r.text.split('\n').slice(1).join('\n').trim() || r.text;

/** The fenced block after `label` in a task text. */
function fenced(text: string, label: string): string | undefined {
  const at = text.indexOf(label);
  if (at < 0) return undefined;
  return text.slice(at).match(/"""\n([\s\S]*?)\n"""/)?.[1];
}

// ---------- COS ----------

interface CosTask {
  id: string;
  agent: string;
  state: string;
  summary: string;
  next: string;
}
interface CosQuestion {
  taskId: string;
  relayed: boolean;
}

function cosContext(text: string): { tasks: CosTask[]; questions: CosQuestion[] } {
  const tasksBlock = text.match(/<subagent_tasks>\n([\s\S]*?)\n<\/subagent_tasks>/)?.[1] ?? '';
  const tasks = [...tasksBlock.matchAll(/^- (\S+) \((\w+)\) ([\w-]+)(?:: (.*))?\n {2}next: (.*)$/gm)].map((m) => ({
    id: m[1]!,
    agent: m[2]!,
    state: m[3]!,
    summary: m[4] ?? '',
    next: m[5]!,
  }));
  const qBlock = text.match(/<pending_subagent_questions>\n([\s\S]*?)\n<\/pending_subagent_questions>/)?.[1] ?? '';
  const questions = [...qBlock.matchAll(/^- taskId=(\S+) agent=\w+ received_at=\S+( relayed_at=\S+)?/gm)].map((m) => ({ taskId: m[1]!, relayed: Boolean(m[2]) }));
  return { tasks, questions };
}

/** A Telegram message from the user starts with its timestamp and OpenClaw's "Conversation info" block. */
const USER_MESSAGE = /^\s*\[[^\]\n]+\]\s*Conversation info:/;

/** What the user wrote: without the timestamp, OpenClaw's "Conversation info" block and the plugin's context. */
function userSaid(text: string): string {
  return text
    .split('<order_state>')[0]!
    .split('<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>')[0]!
    .replace(/^\s*\[[^\]\n]+\]\s*/, '')
    .replace(/^Conversation info:[^\n]*\n```json\n[\s\S]*?\n```\s*/, '')
    .trim();
}

function cosScript(c: Conversation, r: Replay, probes: Probes): never {
  const texts = c.turnTexts();
  const turn = texts.join('\n');
  const ctx = cosContext(turn);
  /** `last`: the message ends the turn; otherwise COS continues after it (final: false). */
  const say = (message: string, last = true) => {
    const res = r.call('message', { action: 'send', message, ...(last ? {} : { final: false }) });
    if (res.isError) throw new Error(`COS message refused: ${res.text}`);
  };
  const start = (agent: string, args: Record<string, unknown>, ack?: string): never => {
    const created = r.call('poo_task', { agent, instruction: '', ...args });
    if (created.isError) throw new Error(`poo_task refused: ${created.text}`);
    const spawned = r.call('sessions_spawn', { agentId: agent, task: json(created).taskId });
    if (spawned.isError) throw new Error(`sessions_spawn refused: ${spawned.text}`);
    r.call('sessions_yield', ack ? { acknowledgment: ack } : {});
    return r.end(`Started ${agent}; waiting for its result.`);
  };
  /** Act on a task report's next step, as a model following it would. */
  const follow = (task: { id?: string; taskId?: string; agent: string; state: string; next: string; selection?: Array<{ name: string; qty: number }>; differences?: unknown[] }): never => {
    const id = task.taskId ?? task.id!;
    const next = task.next;
    if (task.state === 'input-required' && next.includes('@relay')) {
      say(`@relay:${id}`);
      return r.end('Relayed the question; waiting for the answer.');
    }
    if (next.includes('Basket verified')) {
      say('Кошик готовий. Відкрийте посилання, щоб перевірити і оформити замовлення:\n{{cart_link}}');
      return r.end('Sent the basket link.');
    }
    if (next.includes('poo_task {"agent":"execute"}')) {
      say('Обрано. Наповнюю кошик.', false);
      return start('execute', {});
    }
    if (next.includes('poo_task {"agent":"qa"}')) return start('qa', {});
    if (next.includes('Tell the user the differences')) {
      say(`Кошик відрізняється від замовлення (${task.id ?? id}). Виправити?`);
      return r.end('Asked the user about the differences.');
    }
    if (next.includes('Confirm to the user what was added/removed')) {
      say('Збережено: список товарів оновлено.');
      return r.end('Confirmed the product list update.');
    }
    if (task.state === 'running' || task.state === 'created') return r.end('Waiting for the task.');
    say(`Не вдалося виконати крок (${task.state}).`);
    return r.end(`Task ${id} is ${task.state}.`);
  };

  // Anything else that starts a COS run is runtime context: a sub-agent finished a run.
  if (!USER_MESSAGE.test(texts[0] ?? '')) {
    const unrelayed = ctx.questions.find((q) => !q.relayed);
    if (unrelayed) {
      say(`@relay:${unrelayed.taskId}`);
      return r.end('Relayed the question; waiting for the answer.');
    }
    const latest = ctx.tasks.at(-1);
    if (!latest) return r.end('No task to follow.');
    return follow(latest);
  }

  const said = userSaid(texts[0] ?? '');
  const asked = ctx.questions.find((q) => q.relayed);
  if (asked) {
    const stored = r.call('poo_answer', { taskId: asked.taskId, answer: said });
    if (stored.isError) throw new Error(`poo_answer refused: ${stored.text}`);
    const send = JSON.parse(json(stored).next.match(/sessions_send (\{.*?\})/)![1]!);
    const delivered = r.call('sessions_send', send);
    return follow(json(delivered) as never);
  }
  if (/^save this/i.test(said)) {
    const m = said.match(/add\s+(.+?)(?:\s+×\s+(\d+))?\s+to every (?:future )?order/i);
    if (!m) throw new Error(`COS cannot read what to remember in: ${said}`);
    const line = `- ${m[1]} × ${m[2] ?? 1}`;
    const edited = r.call('edit', { path: 'MEMORY.md', edits: [{ oldText: '## Every order\n', newText: `## Every order\n\n${line}\n` }] });
    if (edited.isError) throw new Error(`COS could not edit its memory: ${edited.text}`);
    say(`Запам'ятав: ${m[1]} × ${m[2] ?? 1} буде в кожному новому замовленні.`);
    return r.end('Saved to memory.');
  }
  if (/save info/i.test(said)) {
    const product = said.match(/add\s+"?(.+?)"?\s+to product list/i)?.[1];
    if (!product) throw new Error(`COS cannot read the product in: ${said}`);
    return start('explore', { action: 'update-product-list', add: [product], instruction: said }, 'Зараз оновлю список.');
  }
  if (/прибери зайве/i.test(said)) {
    const qa = [...ctx.tasks].reverse().find((t) => t.agent === 'qa');
    if (!qa) throw new Error('COS: no QA task to fix from');
    const status = json(r.call('poo_task_status', { taskId: qa.id }));
    const ops = (status.differences as Array<{ name: string; expectedQty: number }>).map((d) => ({ name: d.name, targetQty: d.expectedQty }));
    return start('execute', { action: 'fix', ops, instruction: said }, 'Виправляю кошик.');
  }
  if (/^(?:add|додай)\s/i.test(said)) return start('explore', { merge: true, instruction: said }, 'Додаю до замовлення.');
  if (/хочу замовити/i.test(said)) {
    if (probes.forbidden) {
      const link = r.call('message', { action: 'send', message: PROBE.cosCartLink });
      if (!link.isError) throw new Error('the basket link went out before verification');
      const file = r.call('write', { path: PROBE.cosWrite, content: 'overwritten' });
      if (!file.isError) throw new Error('COS wrote a file other than its memory');
    }
    // Every-order products come from COS's memory, which OpenClaw puts into its system prompt.
    const standing = everyOrder(c.system);
    return start('explore', { instruction: said, ...(standing.length ? { standing } : {}) }, 'Зараз запитаю, що замовити.');
  }
  say('Напишіть «хочу замовити», щоб почати.');
  return r.end('Answered small talk.');
}

// ---------- Explore ----------

function exploreScript(c: Conversation, r: Replay, probes: Probes): never {
  const task = c.firstUserText();
  const shopId = task.match(/for shop "([^"]+)"/)?.[1];
  if (!shopId) throw new Error('explore task without a shop');
  if (probes.forbidden) {
    const env = r.call('read', { path: PROBE.exploreRead });
    if (!env.isError) throw new Error('explore read a file outside its skill');
  }
  const skill = r.call('read', { path: 'skills/ask-what-to-buy/SKILL.md' }, 'Reading my skill.');
  if (skill.isError) throw new Error(`explore could not read its skill: ${skill.text}`);
  const products = parseProductTable(skill.text, shopId);

  if (/Task: update-product-list/.test(task)) {
    const add = JSON.parse(task.match(/Add: (\[.*?\])\./)![1]!) as string[];
    const remove = JSON.parse(task.match(/Remove: (\[.*?\])\./)![1]!) as string[];
    const res = r.call('poo_update_product_list', { add, remove });
    if (res.isError) throw new Error(`poo_update_product_list failed: ${res.text}`);
    return r.end(`Product list updated: added ${(json(res).added as string[]).join('; ') || 'nothing'}.`);
  }

  // Merge: COS's message names the products to add ("add 5 - 2"), so they are read without asking.
  const adding = /^Merge: /m.test(task) ? task.match(/Message from the Chief of Staff:\n(?:add|додай)\s+(.+)/i)?.[1] : undefined;
  if (adding) {
    const res = r.call('poo_submit_selection', { outcome: 'selected', items: parseSelection(adding, products) });
    if (res.isError) throw new Error(`poo_submit_selection failed: ${res.text}`);
    return r.end(summaryOf(res));
  }

  const question = fenced(task, 'Send it with poo_ask_user word for word');
  if (!question) throw new Error('explore task without the rendered product question');
  const standing = (task.match(/^Every-order products: (.+?)\. The user asked/m)?.[1] ?? '')
    .split('; ')
    .filter(Boolean)
    .map((item) => item.match(/^(.+) × (\d+)$/)!)
    .map((m) => ({ name: m[1]!, qty: Number(m[2]) }));
  if (question !== productQuestion(products, standing)) throw new Error('the rendered question does not match the skill table');
  r.call('poo_ask_user', { question });
  const askedAt = c.calls.find((x) => x.name === 'poo_ask_user')!.msgIndex;
  const answered = c.laterTexts(askedAt, 'The user answered your question').at(-1);
  if (!answered) return r.end("Waiting for the user's answer.");
  const answer = answered.match(/verbatim:\n"""\n([\s\S]*?)\n"""/)?.[1];
  if (answer === undefined) throw new Error('explore: answer message without the answer');
  const res = r.call('poo_submit_selection', { outcome: 'selected', items: parseSelection(answer, products) });
  if (res.isError) throw new Error(`poo_submit_selection failed: ${res.text}`);
  return r.end(summaryOf(res));
}

// ---------- Execute ----------

interface PageStatus {
  ready?: boolean;
}
interface StoredCart {
  lines?: Array<{ name: string; qty: number; unitPrice?: number; amount?: number; sku?: string }>;
  total?: number;
}
interface SetQtyResult {
  status?: string;
  after?: number;
  detail?: string;
}

const PW = (tool: string) => `playwright__${tool}`;

function field(text: string, re: RegExp, what: string): string {
  const v = text.match(re)?.[1];
  if (!v) throw new Error(`no ${what} in the task`);
  return v;
}

/** Open the run's own tab (over CDP: a new tab) and wait until the helper reports the page ready. */
function openShop(r: Replay, baseUrl: string): boolean {
  r.call(PW('browser_tabs'), { action: 'new', url: baseUrl }, 'Opening my own tab on the shop.');
  const status = () => {
    const res = r.call(PW('browser_evaluate'), { function: '() => window.__poo.status()' });
    return res.isError ? undefined : (pageValue(res.text) as PageStatus | undefined);
  };
  let s = status();
  for (let i = 0; !s?.ready && i < 10; i++) {
    r.call(PW('browser_wait_for'), { time: 2 });
    s = status();
  }
  return Boolean(s?.ready);
}

function executeScript(c: Conversation, r: Replay, probes: Probes): never {
  const task = c.firstUserText();
  const ops = JSON.parse(field(task, /Same operations as JSON:\n(\[.*\])/, 'operations JSON')) as Array<{ name: string; targetQty: number }>;
  const baseUrl = field(task, /^Shop: .*\((https?:\/\/[^)]+)\)\.$/m, 'shop URL');
  const evaluate = <T>(expr: string): T | undefined => {
    const res = r.call(PW('browser_evaluate'), { function: `() => ${expr}` });
    return res.isError ? undefined : (pageValue(res.text) as T);
  };

  if (!openShop(r, baseUrl)) {
    r.call('poo_submit_execute', { ops: ops.map((op) => ({ ...op, status: 'failed', detail: 'the shop page never became ready' })), cart: [] });
    return r.end('The shop page never became ready.');
  }
  if (probes.forbidden) {
    for (const [tool, input] of [
      [PW('browser_navigate'), { url: PROBE.executeNavigate }],
      [PW('browser_evaluate'), { function: PROBE.executeFreeJs }],
      [PW('browser_evaluate'), { function: PROBE.executeOrderForm }],
      [PW('browser_click'), { target: '.t706__carticon-wrapper', element: 'cart icon' }],
    ] as const) {
      if (!r.call(tool, input).isError) throw new Error(`execute was allowed ${tool} ${JSON.stringify(input)}`);
    }
  }
  const before = evaluate<StoredCart>('window.__poo.readCart()');
  if (task.includes('New order: clear the basket first.')) {
    const wanted = new Set(ops.map((op) => op.name));
    for (const line of before?.lines ?? []) {
      if (!wanted.has(line.name)) evaluate<SetQtyResult>(`window.__poo.setQty(${JSON.stringify(line.name)}, 0)`);
    }
  }
  const results = new Map<string, SetQtyResult | undefined>();
  for (const op of ops) {
    const call = `window.__poo.setQty(${JSON.stringify(op.name)}, ${op.targetQty})`;
    let res = evaluate<SetQtyResult>(call);
    if (res?.status === 'failed') res = evaluate<SetQtyResult>(call); // the playbook allows one retry
    results.set(op.name, res);
  }
  const after = evaluate<StoredCart>('window.__poo.readCart()');
  const out = r.call('poo_submit_execute', {
    ops: ops.map((op) => {
      const res = results.get(op.name);
      const status = res?.status === 'ok' || res?.status === 'not_found' ? res.status : 'failed';
      return {
        name: op.name,
        targetQty: op.targetQty,
        status,
        ...(typeof res?.after === 'number' ? { actualQty: res.after } : {}),
        ...(status !== 'ok' ? { detail: res?.detail ?? 'setQty returned no result' } : {}),
      };
    }),
    cart: (after?.lines ?? []).map((l) => ({ name: l.name, qty: l.qty, ...(l.sku ? { sku: l.sku } : {}) })),
  });
  if (out.isError) throw new Error(`poo_submit_execute failed: ${out.text}`);
  return r.end(summaryOf(out));
}

// ---------- QA ----------

interface ModalView {
  open?: boolean;
  lines?: Array<{ name: string; qty: number; amount?: number | null }>;
  total?: number | null;
}

function qaScript(c: Conversation, r: Replay, probes: Probes): never {
  const task = c.firstUserText();
  const baseUrl = field(task, /^Shop: .*\((https?:\/\/[^)]+)\)\.$/m, 'shop URL');
  const evaluate = <T>(expr: string): T | undefined => {
    const res = r.call(PW('browser_evaluate'), { function: `() => ${expr}` });
    return res.isError ? undefined : (pageValue(res.text) as T);
  };
  if (!openShop(r, baseUrl)) {
    r.call('poo_submit_qa', { modalOpened: false, readVia: 'storage', lines: [], total: null, notes: 'The shop page never became ready.' });
    return r.end('The shop page never became ready.');
  }
  if (probes.forbidden) {
    if (!r.call(PW('browser_evaluate'), { function: PROBE.qaWrite }).isError) throw new Error('QA was allowed to change the basket');
    if (!r.call('message', { action: 'send', message: PROBE.qaMessage }).isError) throw new Error('QA was allowed to message the user');
  }
  let modal: ModalView | undefined;
  for (const target of ['.t706__carticon-wrapper', 'a.t-menuwidgeticons__link_cart']) {
    if (r.call(PW('browser_click'), { target, element: 'basket icon' }, 'Opening the basket like the user.').isError) continue;
    modal = evaluate<ModalView>('window.__poo.readModal()');
    for (let i = 0; !modal?.open && i < 3; i++) {
      r.call(PW('browser_wait_for'), { time: 1 });
      modal = evaluate<ModalView>('window.__poo.readModal()');
    }
    if (modal?.open) break;
  }
  const stored = evaluate<StoredCart>('window.__poo.readCart()');
  const lines = (modal?.open ? modal.lines : stored?.lines) ?? [];
  const out = r.call('poo_submit_qa', {
    modalOpened: Boolean(modal?.open),
    readVia: modal?.open ? 'both' : 'storage',
    lines: lines.map((l) => ({ name: l.name, qty: l.qty })),
    total: modal?.open ? (modal.total ?? null) : (stored?.total ?? null),
  });
  if (out.isError) throw new Error(`poo_submit_qa failed: ${out.text}`);
  return r.end(summaryOf(out));
}

// ---------- policy ----------

const SCRIPTS: Record<AgentKind, (c: Conversation, r: Replay, probes: Probes) => never> = {
  cos: cosScript,
  explore: exploreScript,
  execute: executeScript,
  qa: qaScript,
};

export function scriptedPolicy(probes: Probes): (body: Record<string, unknown>) => PolicyResult {
  return (body) => {
    const c = new Conversation(body);
    const agent = c.agent();
    // Not an agent turn (activity recaps, titles): a short, harmless text.
    if (!agent) return { agent: 'side', reply: { kind: 'text', text: 'NO_REPLY' } };
    // COS replays only its current run; a child replays its whole session (a continued task resumes its script).
    const calls = agent === 'cos' ? c.turnCalls() : c.calls;
    try {
      SCRIPTS[agent](c, new Replay(agent, calls), probes);
    } catch (err) {
      if (err instanceof NextReply) return { agent, reply: err.reply };
      throw err;
    }
    throw new Error(`${agent} script returned without a reply`);
  };
}
