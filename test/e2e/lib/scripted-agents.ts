/**
 * Scripted "models" for the four agents. Each request is answered from its own body only: the agent is
 * recognised by its system prompt (the agent's AGENTS.md), and the next step is derived by replaying the
 * agent's script over the tool calls and tool results already in the conversation. So the mock behaves
 * like a model that reads what its tools returned (the skill's product table, page-script results,
 * A2A task reports) instead of following a fixed list of replies.
 */
import type { MockReply, PolicyResult } from './mock-anthropic.js';

export type AgentKind = 'cos' | 'explore' | 'execute' | 'qa';

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

interface Msg {
  role: string;
  blocks: Block[];
}

export interface ToolResult {
  text: string;
  isError: boolean;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  /** Index of the assistant message that made the call. */
  msgIndex: number;
  result?: ToolResult;
}

const blocksOf = (content: unknown): Block[] =>
  typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? (content as Block[]) : [];

const textOfContent = (content: unknown): string =>
  blocksOf(content)
    .map((b) => (b.type === 'text' ? (b.text ?? '') : ''))
    .join('\n');

export class Conversation {
  readonly system: string;
  readonly tools: string[];
  readonly messages: Msg[];
  readonly calls: ToolCall[] = [];

  constructor(body: Record<string, unknown>) {
    this.system = textOfContent(body.system);
    this.tools = ((body.tools as Array<{ name?: string }> | undefined) ?? []).map((t) => String(t.name));
    this.messages = ((body.messages as Array<{ role: string; content: unknown }> | undefined) ?? []).map((m) => ({
      role: m.role,
      blocks: blocksOf(m.content),
    }));
    const byId = new Map<string, ToolCall>();
    this.messages.forEach((m, msgIndex) => {
      for (const b of m.blocks) {
        if (m.role === 'assistant' && b.type === 'tool_use' && b.id && b.name) {
          const call: ToolCall = { id: b.id, name: b.name, input: (b.input ?? {}) as Record<string, unknown>, msgIndex };
          byId.set(b.id, call);
          this.calls.push(call);
        } else if (m.role === 'user' && b.type === 'tool_result' && b.tool_use_id) {
          const call = byId.get(b.tool_use_id);
          if (call) call.result = { text: textOfContent(b.content), isError: b.is_error === true };
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

  userTexts(index: number): string {
    const m = this.messages[index];
    return m && m.role === 'user' ? m.blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n') : '';
  }

  firstUserText(): string {
    const i = this.messages.findIndex((m) => m.role === 'user');
    return i < 0 ? '' : this.userTexts(i);
  }

  lastUserIndexWith(fragment: string): number {
    for (let i = this.messages.length - 1; i >= 0; i--) if (this.userTexts(i).includes(fragment)) return i;
    return -1;
  }

  /** The skill body the CLI injects next to the Skill tool result. */
  skillText(): string | undefined {
    for (const m of this.messages) {
      if (m.role !== 'user') continue;
      for (const b of m.blocks) if (b.type === 'text' && b.text?.startsWith('Base directory for this skill')) return b.text;
    }
    return undefined;
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

  end(text = ''): never {
    if (this.i < this.calls.length) throw new Error(`${this.agent} script ended after ${this.i} calls but the conversation has ${this.calls.length}`);
    throw new NextReply({ kind: 'text', text });
  }
}

// ---------- parsing helpers ----------

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The value a page script returned, from a Playwright MCP or agent-browser MCP tool result text. */
export function pageValue(text: string): unknown {
  const section = text.match(/### Result\s*\n([\s\S]*?)(?:\n### |$)/);
  const candidate = (section ? section[1]! : text).trim();
  let parsed = tryJson(candidate);
  if (parsed === undefined) {
    const start = candidate.search(/[[{]/);
    if (start >= 0) parsed = tryJson(candidate.slice(start));
  }
  // agent-browser wraps results in an envelope ({success, data: {result}} / {result} / {response: {data: {result}}}).
  for (let depth = 0; depth < 4 && parsed && typeof parsed === 'object' && !Array.isArray(parsed); depth++) {
    const o = parsed as Record<string, unknown>;
    const known = ['ready', 'lines', 'open', 'status', 'found'].some((k) => k in o);
    if (known) break;
    if ('result' in o) parsed = typeof o.result === 'string' ? (tryJson(o.result) ?? o.result) : o.result;
    else if ('data' in o) parsed = o.data;
    else if ('response' in o) parsed = o.response;
    else break;
  }
  return parsed;
}

const json = (r: ToolResult): Record<string, unknown> => {
  const v = tryJson(r.text);
  if (!v || typeof v !== 'object') throw new Error(`expected a JSON tool result, got: ${r.text.slice(0, 300)}`);
  return v as Record<string, unknown>;
};

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
    .map((l) => l.trim())
    .filter((l) => /^\|\s*\d+\s*\|/.test(l))
    .map((l) => {
      const [n, name, sku, price] = l.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      return { n: Number(n), name: name ?? '', sku: sku ?? '', price: price ?? '' };
    });
}

export const QUESTION_HEAD =
  'Що замовити? Напишіть номер товару і кількість, кожен товар з нового рядка, у форматі «номер - кількість». Без кількості = 1 шт.';

export function productQuestion(products: readonly Product[]): string {
  return [
    QUESTION_HEAD,
    'Наприклад:',
    '1 - 2',
    '5',
    '',
    ...products.map((p) => `${p.n}. ${p.name}${p.price ? ` — ≈${p.price} грн` : ''}`),
  ].join('\n');
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

// ---------- the agents ----------

const COS = (tool: string) => `mcp__cos__${tool}`;
const PW = (tool: string) => `mcp__playwright__${tool}`;
const AB = (tool: string) => `mcp__agent_browser__${tool}`;
const STRUCTURED = 'StructuredOutput';

function exploreScript(conv: Conversation, r: Replay): never {
  const prompt = conv.firstUserText();
  const action = prompt.match(/Task: (select-products|update-product-list)/)?.[1];
  const request = tryJson(prompt.match(/^Request: (\{.*\})$/m)?.[1] ?? '') as
    | { shopId: string; add?: string[]; remove?: string[] }
    | undefined;
  if (!action || !request) throw new Error('explore prompt without a task/request');
  r.call('Skill', { skill: 'ask-what-to-buy' }, 'Loading the product list skill.');
  const skill = conv.skillText();
  if (!skill) throw new Error('the Skill tool result did not inject the skill body');
  const products = parseProductTable(skill, request.shopId);

  if (action === 'select-products') {
    // The question comes rendered from the skill's table in the task prompt; a model sends it unchanged.
    const question = prompt.match(/word for word:\n"""\n([\s\S]*?)\n"""/)?.[1];
    if (!question) throw new Error('explore prompt without the rendered product question');
    if (question !== productQuestion(products)) throw new Error('the rendered question does not match the skill table');
    const answer = r.call('mcp__explore__ask_user', { question });
    // A canceled question (COS /stop) comes back as a tool error: a real model would just stop here.
    if (answer.isError) return r.end('The question was canceled; stopping.');
    const items = parseSelection(answer.text, products);
    const out = r.call(STRUCTURED, { outcome: 'selected', items });
    if (out.isError) throw new Error(`StructuredOutput rejected: ${out.text}`);
    return r.end('Selection returned.');
  }
  const update = r.call('mcp__explore__update_product_list', { shopId: request.shopId, add: request.add ?? [], remove: request.remove ?? [] });
  if (update.isError) throw new Error(`update_product_list failed: ${update.text}`);
  const report = json(update);
  const out = r.call(STRUCTURED, { notes: `The list now has ${String(report.productCount)} products.` });
  if (out.isError) throw new Error(`StructuredOutput rejected: ${out.text}`);
  return r.end('List updated.');
}

interface PageStatus {
  ready?: boolean;
  cartLines?: number;
}
interface StoredCart {
  lines?: Array<{ name: string; qty: number; unitPrice?: number; amount?: number; sku?: string }>;
}
interface SetQtyResult {
  status?: string;
  name?: string;
  before?: number;
  after?: number;
  detail?: string;
}

function promptField(prompt: string, re: RegExp, what: string): string {
  const v = prompt.match(re)?.[1];
  if (!v) throw new Error(`no ${what} in the prompt`);
  return v;
}

function executeScript(conv: Conversation, r: Replay): never {
  const prompt = conv.firstUserText();
  const ops = JSON.parse(promptField(prompt, /Same operations as JSON:\n(\[.*\])/, 'operations JSON')) as Array<{ name: string; targetQty: number }>;
  const shopId = promptField(prompt, /shopId "([^"]+)"/, 'shopId');
  const cartUrl = promptField(prompt, /cartUrl "([^"]+)"/, 'cartUrl');
  const baseUrl = promptField(prompt, /^Shop: .*\((https?:\/\/[^)]+)\)\.$/m, 'shop URL');
  const evaluate = <T>(expr: string): T | undefined => {
    const res = r.call(PW('browser_evaluate'), { function: `() => ${expr}` });
    return res.isError ? undefined : (pageValue(res.text) as T);
  };

  r.call(PW('browser_tabs'), { action: 'new', url: baseUrl }, 'Opening my own tab on the shop.');
  let status = evaluate<PageStatus>('window.__poo.status()');
  for (let i = 0; !status?.ready && i < 10; i++) {
    r.call(PW('browser_wait_for'), { time: 2 });
    status = evaluate<PageStatus>('window.__poo.status()');
  }
  if (!status?.ready) {
    r.call(STRUCTURED, {
      type: 'execute-result',
      shopId,
      cartUrl,
      ops: ops.map((op) => ({ ...op, status: 'failed', detail: 'the shop page never became ready' })),
      cart: [],
    });
    return r.end();
  }
  evaluate<StoredCart>('window.__poo.readCart()');
  const results = new Map<string, SetQtyResult | undefined>();
  for (const op of ops) {
    const call = `window.__poo.setQty(${JSON.stringify(op.name)}, ${op.targetQty})`;
    let res = evaluate<SetQtyResult>(call);
    if (res?.status === 'failed') res = evaluate<SetQtyResult>(call); // the playbook allows one retry
    results.set(op.name, res);
  }
  const after = evaluate<StoredCart>('window.__poo.readCart()');
  const out = r.call(STRUCTURED, {
    type: 'execute-result',
    shopId,
    cartUrl,
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
    cart: (after?.lines ?? []).map((l) => ({
      name: l.name,
      qty: l.qty,
      ...(typeof l.unitPrice === 'number' ? { unitPrice: l.unitPrice } : {}),
      ...(typeof l.amount === 'number' ? { amount: l.amount } : {}),
      ...(l.sku ? { sku: l.sku } : {}),
    })),
  });
  if (out.isError) throw new Error(`StructuredOutput rejected: ${out.text}`);
  return r.end('Basket updated.');
}

/** A forbidden basket write the scripted QA "model" attempts once per run: the read-only guard must deny it. */
export const QA_GUARD_PROBE = 'window.__poo.setQty("Філе зі стегна індички, 1 кг", 5)';

function qaScript(conv: Conversation, r: Replay): never {
  const prompt = conv.firstUserText();
  const baseUrl = promptField(prompt, /^Shop: .*\((https?:\/\/[^)]+)\)\.$/m, 'shop URL');
  const evaluate = <T>(script: string): T | undefined => {
    const res = r.call(AB('agent_browser_eval'), { script });
    return res.isError ? undefined : (pageValue(res.text) as T);
  };

  r.call(AB('agent_browser_open'), { url: baseUrl }, 'Opening my own tab on the shop.');
  let status = evaluate<PageStatus>('window.__poo.status()');
  for (let i = 0; !status?.ready && i < 10; i++) {
    r.call(AB('agent_browser_wait_ms'), { ms: 2000 });
    status = evaluate<PageStatus>('window.__poo.status()');
  }
  const probe = r.call(AB('agent_browser_eval'), { script: QA_GUARD_PROBE });
  const notes: string[] = [probe.isError ? 'basket-write probe denied by the guard' : 'WARNING: basket-write probe was NOT denied'];

  let modalOpened = false;
  if ((status?.cartLines ?? 0) > 0) {
    let click = r.call(AB('agent_browser_click'), { selector: '.t706__carticon-wrapper' }, 'Opening the basket from the top-right icon.');
    if (click.isError) click = r.call(AB('agent_browser_click'), { selector: 'a.t-menuwidgeticons__link_cart' });
    const waited = r.call(AB('agent_browser_wait_for_selector'), { selector: '.t706__cartwin.t706__cartwin_showed', waitTimeoutMs: 10000 });
    if (waited.isError) notes.push(`cart window wait failed: ${waited.text.slice(0, 120)}`);
    r.call(AB('agent_browser_get_text'), { selector: '.t706__cartwin-products' });
  }
  const modal = evaluate<{ open?: boolean; lines?: Array<{ name: string; qty: number; amount?: number | null }>; total?: number | null }>(
    'window.__poo.readModal()',
  );
  const stored = evaluate<StoredCart>('window.__poo.readCart()');
  modalOpened = modal?.open === true;
  const storedByName = new Map((stored?.lines ?? []).map((l) => [l.name, l]));
  const source = modalOpened ? (modal?.lines ?? []) : (stored?.lines ?? []);
  const lines = source
    .filter((l) => l.name)
    .map((l) => {
      const s = storedByName.get(l.name);
      const amount = typeof l.amount === 'number' ? l.amount : s?.amount;
      return {
        name: l.name,
        qty: l.qty,
        ...(typeof s?.unitPrice === 'number' ? { unitPrice: s.unitPrice } : {}),
        ...(typeof amount === 'number' ? { amount } : {}),
        ...(s?.sku ? { sku: s.sku } : {}),
      };
    });
  const modalCount = (modal?.lines ?? []).length;
  const storedCount = (stored?.lines ?? []).length;
  if (modalOpened && modalCount !== storedCount) notes.push(`cart window shows ${modalCount} lines, storage ${storedCount}`);
  const out = r.call(STRUCTURED, {
    modalOpened,
    readVia: modalOpened ? 'both' : 'storage',
    lines,
    total: typeof modal?.total === 'number' ? modal.total : null,
    notes: notes.join('; '),
  });
  if (out.isError) throw new Error(`StructuredOutput rejected: ${out.text}`);
  return r.end('Basket observed.');
}

// ---------- COS ----------

interface CosReport {
  agent?: string;
  taskId?: string;
  state?: string;
  selection?: Array<{ name: string; qty: number }>;
  operations?: Array<{ name: string; status: string }>;
  verdict?: 'match' | 'mismatch';
  differences?: Array<{ kind: string; name: string; expectedQty: number; actualQty: number }>;
  total?: number;
  cartUrl?: string;
  productList?: { added: string[]; removed: string[]; size: number };
  error?: { code: string; message: string; hint?: string };
}

const report = (r: ToolResult): CosReport => {
  if (r.isError) throw new Error(`COS tool failed: ${r.text.slice(0, 300)}`);
  return json(r) as CosReport;
};

/** Expected basket lines from get_order_state ("- name × qty" under "Expected basket"). */
function expectedLines(state: string): Array<{ name: string; qty: number }> {
  const section = state.split(/\nLast |\nPending /)[0] ?? state;
  return [...section.matchAll(/^- (.+) × (\d+)$/gm)].map((m) => ({ name: m[1]!, qty: Number(m[2]) }));
}

/** COS ends every turn with this marker (agents/cos/AGENTS.md); code never shows it to the user. */
const END = 'done';

function cosHandle(r: Replay, rep: CosReport): never {
  if (rep.state === 'input-required' && rep.taskId) {
    r.call(COS('relay_question'), { taskId: rep.taskId });
    return r.end(END);
  }
  if (rep.state !== 'completed' || rep.error) {
    const why = rep.error?.hint ?? rep.error?.message ?? `the ${rep.agent} task ended ${rep.state}`;
    r.call(COS('send_telegram'), { text: `Не вдалося виконати крок (${rep.agent}): ${why}. Повторити?` });
    return r.end(END);
  }
  if (rep.selection) {
    const list = rep.selection.map((i) => `• ${i.name} × ${i.qty}`).join('\n');
    r.call(COS('send_telegram'), { text: `Ваш вибір:\n${list}\nДодаю в кошик.` });
    return cosHandle(r, report(r.call(COS('delegate_task'), { agent: 'execute', action: 'initial', instruction: 'Fill the basket with the selection.' })));
  }
  if (rep.operations) {
    return cosHandle(r, report(r.call(COS('delegate_task'), { agent: 'qa', action: 'verify', instruction: 'Check the basket against the order.' })));
  }
  if (rep.verdict) {
    if (rep.verdict === 'match' && rep.cartUrl) {
      const state = r.call(COS('get_order_state'), {});
      const lines = expectedLines(state.text).map((l) => `• ${l.name} × ${l.qty}`);
      const total = typeof rep.total === 'number' ? `\nРазом: ${rep.total} грн` : '';
      r.call(COS('send_telegram'), {
        text:
          `Кошик готовий:\n${lines.join('\n')}${total}\n\n${rep.cartUrl}\n\n` +
          'Посилання відкриває підготовлений кошик у браузері за замовчуванням. Оформлення й оплата — за вами; я замовлень не надсилаю.',
      });
      return r.end(END);
    }
    const diffs = (rep.differences ?? []).map((d) => `• ${d.name}: очікувалось ${d.expectedQty}, у кошику ${d.actualQty}`);
    r.call(COS('send_telegram'), { text: `Кошик відрізняється від замовлення:\n${diffs.join('\n')}\nВиправити чи залишити як є?` });
    return r.end(END);
  }
  if (rep.productList) {
    const added = rep.productList.added.map((n) => `«${n}»`).join(', ') || 'нічого';
    r.call(COS('send_telegram'), {
      text: `Збережено. Додано до списку: ${added}. Тепер у списку ${rep.productList.size} товарів; наступного разу я його запропоную.`,
    });
    return r.end(END);
  }
  r.call(COS('send_telegram'), { text: 'Завдання завершилось без результату. Повторити?' });
  return r.end(END);
}

/** The last QA report the COS model saw before the current turn started. */
function lastQaReport(conv: Conversation, turnStart: number): CosReport | undefined {
  for (let i = conv.calls.length - 1; i >= 0; i--) {
    const c = conv.calls[i]!;
    if (c.msgIndex > turnStart || !c.result || c.result.isError) continue;
    const v = tryJson(c.result.text) as CosReport | undefined;
    if (v && typeof v === 'object' && v.verdict) return v;
  }
  return undefined;
}

function cosScript(conv: Conversation): never {
  const turnStart = conv.lastUserIndexWith('<telegram_message');
  if (turnStart < 0) throw new Error('COS request without a telegram message');
  const r = new Replay('cos', conv.calls.filter((c) => c.msgIndex > turnStart));
  const wrapped = conv.userTexts(turnStart);
  const tg = [...wrapped.matchAll(/<telegram_message[^>]*>\n([\s\S]*?)\n<\/telegram_message>/g)].map((m) => m[1]!).join('\n');
  const pendingBlock = wrapped.match(/<pending_subagent_questions>\n([\s\S]*?)\n<\/pending_subagent_questions>/)?.[1] ?? '';
  const pending = [...pendingBlock.matchAll(/taskId=(\S+) agent=(\S+)/g)].map((m) => ({ taskId: m[1]!, agent: m[2]! }));

  if (/^save info/i.test(tg.trim())) {
    const product = tg.match(/["«“]([^"»”]+)["»”]/)?.[1];
    if (!product) throw new Error(`cannot find the product in "${tg}"`);
    const rep = report(r.call(COS('delegate_task'), { agent: 'explore', action: 'update-product-list', add: [product], instruction: tg }));
    return cosHandle(r, rep);
  }
  if (/хочу замовити|^order\b/i.test(tg)) {
    const rep = report(
      r.call(COS('delegate_task'), { agent: 'explore', action: 'select-products', instruction: `Користувач написав: «${tg}». Запитай, що купити.` }),
    );
    return cosHandle(r, rep);
  }
  if (/прибери зайве|виправ/i.test(tg)) {
    const qa = lastQaReport(conv, turnStart);
    const ops = (qa?.differences ?? []).map((d) => ({ name: d.name, targetQty: d.kind === 'extra' ? 0 : d.expectedQty }));
    if (ops.length === 0) {
      r.call(COS('send_telegram'), { text: 'Немає чого виправляти: кошик збігається із замовленням.' });
      return r.end(END);
    }
    const rep = report(r.call(COS('delegate_task'), { agent: 'execute', action: 'fix', ops, instruction: `Користувач: «${tg}».` }));
    return cosHandle(r, rep);
  }
  if (/як там|статус/i.test(tg)) {
    const state = r.call(COS('get_order_state'), {});
    r.call(COS('send_telegram'), { text: `Стан замовлення:\n${state.text.split('\n').slice(0, 8).join('\n')}` });
    return r.end(END);
  }
  if (pending.length > 0) {
    const rep = report(r.call(COS('answer_subagent'), { taskId: pending[0]!.taskId, answer: tg }));
    return cosHandle(r, rep);
  }
  r.call(COS('send_telegram'), { text: 'Напишіть «хочу замовити», щоб почати замовлення.' });
  return r.end(END);
}

/** The mock's policy: recognise the agent, replay its script, return the next model output. */
export function scriptedPolicy(body: Record<string, unknown>): PolicyResult {
  const conv = new Conversation(body);
  const agent = conv.agent();
  if (!agent || conv.tools.length === 0) return { agent: 'side', reply: { kind: 'text', text: 'ok' } };
  try {
    switch (agent) {
      case 'cos':
        cosScript(conv);
        break;
      case 'explore':
        exploreScript(conv, new Replay('explore', conv.calls));
        break;
      case 'execute':
        executeScript(conv, new Replay('execute', conv.calls));
        break;
      case 'qa':
        qaScript(conv, new Replay('qa', conv.calls));
        break;
    }
  } catch (signal) {
    if (signal instanceof NextReply) return { agent, reply: signal.reply };
    if (signal instanceof Error) signal.message = `[${agent}] ${signal.message}`;
    throw signal;
  }
  throw new Error(`${agent} script returned without a reply`);
}
