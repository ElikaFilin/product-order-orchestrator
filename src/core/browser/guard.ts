/**
 * Pre-tool-call guard for the Playwright MCP tools of Execute and QA: tool allow-list, navigation allow-list, the
 * shop's forbidden (checkout) patterns, page scripts limited to single calls of the shop's in-page helper
 * (which it injects, so agents can call `window.__poo.*` directly), and the agent's own tab.
 * One guard per agent run: it remembers whether the run has opened its own tab yet, and whether it closed it.
 */
import type { CheckoutDetails } from '../contracts.js';
import type { ShopAdapter } from '../shops/types.js';
import type { BrowserToolset } from './toolset.js';

/** What a guard decided for one tool call: deny it (with the reason the model sees) or run it with other input. */
export interface GuardDecision {
  deny?: string;
  updatedInput?: Record<string, unknown>;
}
/** undefined = no objection. */
export type ToolGuard = (toolName: string, input: Record<string, unknown>) => GuardDecision | undefined;

/** Parameters agents never need: files written anywhere on disk (outputs go to the server's output dir). */
const FORBIDDEN_FIELDS = ['filename', 'path'];

export interface HelperCall {
  method: string;
  args: Array<string | number>;
}

/**
 * One call of the in-page helper with literal arguments, the only page script agents may run:
 * `window.__poo.setQty("name", 2)`, optionally as `() => ...`, `async () => await ...` or `() => { return ...; }`
 * (Playwright passes a function). Arguments must be JSON strings or whole numbers. Anything else is undefined.
 */
export function parseHelperCall(code: string): HelperCall | undefined {
  let body = code.trim().replace(/;$/, '').trim();
  const arrow = body.match(/^(?:async\s+)?\(\s*\)\s*=>\s*([\s\S]*)$/);
  if (arrow) body = arrow[1]!.trim();
  const block = body.match(/^\{\s*return\s+([\s\S]*?)\s*;?\s*\}$/);
  if (block) body = block[1]!.trim();
  body = body.replace(/^await\s+/, '').replace(/;$/, '').trim();
  const call = body.match(/^(?:window\s*\.\s*)?__poo\s*\.\s*(\w+)\s*\(([\s\S]*)\)$/);
  if (!call) return undefined;
  let args: unknown;
  try {
    args = JSON.parse(`[${call[2]}]`);
  } catch {
    return undefined;
  }
  const literal = (a: unknown) => typeof a === 'string' || (typeof a === 'number' && Number.isInteger(a));
  return Array.isArray(args) && args.every(literal) ? { method: call[1]!, args: args as HelperCall['args'] } : undefined;
}

/** How the allowed helper calls look, for deny messages the model can recover from. */
export function describeHelperCalls(methods: readonly string[]): string {
  return `one call per script, e.g. window.__poo.status() or window.__poo.setQty("<exact name>", 2); methods: ${methods.join(', ')}; arguments must be JSON literals (double-quoted strings, whole numbers)`;
}

export interface BrowserGuardOptions {
  /**
   * The run fills the order form with these details: `fillOrderForm()` gets them as its arguments here, so the model
   * never types them. The run then keeps its tab, because the filled form exists only there.
   */
  checkout?: CheckoutDetails;
}

const FILL_ORDER_FORM = 'fillOrderForm';

export function createBrowserGuard(shop: ShopAdapter, toolset: BrowserToolset, opts: BrowserGuardOptions = {}): ToolGuard {
  const prefix = toolset.prefix;
  const allowed = new Set(toolset.allowedTools);
  const tabsTool = toolset.tool('browser_tabs');
  const helperMethods = [...shop.helperApi.read, ...shop.helperApi.write];
  const checkout = opts.checkout;
  // Attached over CDP, Playwright MCP starts with one of the USER's tabs as its current tab, so nothing may run
  // before this run has opened its own (see BrowserToolset.startsInOwnTab).
  let ownTabOpened = toolset.startsInOwnTab;
  // Closing the current tab can hit only the run's own tab when the session sees nothing else. After that every
  // browser tool is denied: the next call would reconnect and leave a new tab behind.
  const closesOwnTab = (input: Record<string, unknown>) => toolset.seesOnlyOwnTabs && input.action === 'close' && input.index === undefined;
  let ownTabClosed = false;
  const tabActions = `${tabsTool} {"action":"new","url":"${shop.baseUrl}"}${toolset.seesOnlyOwnTabs && !checkout ? ' and {"action":"close"} (your own tab, as your last browser call)' : ''}`;

  return (toolName, input): GuardDecision | undefined => {
    if (!toolName.startsWith(prefix)) return undefined;
    if (!allowed.has(toolName)) return { deny: `${toolName} is not available to this agent.` };
    if (ownTabClosed) return { deny: 'Your tab is closed, so the browser work of this run is over: give your result now.' };

    const field = FORBIDDEN_FIELDS.find((f) => input[f] !== undefined);
    if (field) return { deny: `The "${field}" parameter is not allowed.` };
    if (input.submit === true) return { deny: 'Submitting forms is not allowed.' };

    if (typeof input.url === 'string' && !isAllowedUrl(input.url, shop.allowedOrigins)) {
      return { deny: `Navigation to ${input.url} is not allowed. Allowed: ${shop.allowedOrigins.join(', ')} and about:blank.` };
    }
    for (const text of strings(input)) {
      const pattern = shop.forbiddenPatterns.find((p) => text.search(p) !== -1);
      if (pattern) {
        return { deny: `Blocked by the ${shop.id} safety rules (${pattern}): agents never touch the order form or submit orders.` };
      }
    }

    if (toolName === tabsTool) {
      if (closesOwnTab(input)) {
        if (checkout) return { deny: 'Keep your tab open: the filled order form exists only in it, and the user sends the order from it.' };
        ownTabClosed = true;
        return undefined;
      }
      if (input.action !== 'new') {
        return { deny: `Only ${tabActions} available. Never list, select or close other tabs: they belong to the user.` };
      }
      ownTabOpened = true;
      return undefined;
    }
    if (!ownTabOpened) {
      return { deny: `Open your own tab first: ${tabsTool} {"action":"new","url":"${shop.baseUrl}"}. Until then every browser tool would act on the user's tab.` };
    }

    if (toolName !== toolset.evalTool.name) return undefined;
    const codeField = toolset.evalTool.codeField;
    const code = input[codeField];
    const call = typeof code === 'string' ? parseHelperCall(code) : undefined;
    if (!call || !helperMethods.includes(call.method)) {
      return { deny: `Page scripts may only call the shop helper: ${describeHelperCalls(helperMethods)}.` };
    }
    if (call.method === FILL_ORDER_FORM) {
      if (!checkout) return { deny: 'Filling the order form is not set up: leave the form to the user.' };
      if (call.args.length) return { deny: "Call window.__poo.fillOrderForm() without arguments: the system puts in the user's details." };
      const args = [checkout.name, checkout.phone, checkout.delivery, checkout.address].map((a) => JSON.stringify(a)).join(', ');
      return { updatedInput: { ...input, [codeField]: withHelper(shop, `() => window.__poo.${FILL_ORDER_FORM}(${args})`) } };
    }
    return { updatedInput: { ...input, [codeField]: withHelper(shop, code as string) } };
  };
}

function isAllowedUrl(raw: string, origins: readonly string[]): boolean {
  const value = raw.trim();
  if (value === 'about:blank') return true;
  const url = parseUrl(value);
  return url !== undefined && (url.protocol === 'https:' || url.protocol === 'http:') && origins.includes(url.origin);
}

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    // A bare host ("karashynyard.com.ua/"): the browser tools treat it as https.
  }
  try {
    return new URL(`https://${value}`);
  } catch {
    return undefined;
  }
}

function* strings(value: unknown): Generator<string> {
  if (typeof value === 'string') yield value;
  else if (Array.isArray(value)) for (const item of value) yield* strings(item);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) yield* strings(item);
}

/**
 * Prepend the helper while keeping the agent's code semantics. The script first checks that its tab is on the
 * shop: Playwright silently falls back to a neighbouring (user) tab when the agent's tab closes, and no helper may
 * ever run there.
 */
export function withHelper(shop: Pick<ShopAdapter, 'allowedOrigins' | 'helperSource'>, code: string): string {
  const onShop =
    `if (!${JSON.stringify(shop.allowedOrigins)}.includes(location.origin)) ` +
    "throw new Error('This tab is not on the shop (' + location.origin + '): open your own shop tab first.');";
  // Playwright MCP evaluates `(<function>)` and calls it (with the target element when one is given); a plain
  // expression is returned as is. Newlines keep a trailing `// comment` from swallowing code.
  return [
    'async (element) => {',
    onShop,
    shop.helperSource,
    `const __pooValue = (\n${code}\n);`,
    "return await (typeof __pooValue === 'function' ? __pooValue(element) : __pooValue);",
    '}',
  ].join('\n');
}
