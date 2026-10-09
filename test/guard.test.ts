import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { createBrowserGuard, parseHelperCall, withHelper } from '../src/browser/guard.js';
import { browserToolset, type BrowserMcpKind, type BrowserRole } from '../src/browser/mcp.js';
import type { ToolGuard } from '../src/shared/claude.js';
import { karashynyard } from '../src/shops/karashynyard/index.js';
import type { ShopAdapter } from '../src/shops/types.js';

const SHOP_ORIGIN = 'https://karashynyard.com.ua';
const toolset = (kind: BrowserMcpKind, role: BrowserRole = 'execute') =>
  browserToolset(kind, { role, connection: { mode: 'cdp', cdpUrl: 'http://127.0.0.1:9333' }, outputDir: '/tmp/poo-test', blockedOrigins: karashynyard.blockedOrigins, session: 'test' });
const pw = toolset('playwright', 'qa');
const ab = toolset('agent-browser', 'qa');

/** A Playwright guard whose run has already opened its own tab, and an agent-browser guard (always in its own tab). */
function guards(shop: ShopAdapter = karashynyard): { pwGuard: ToolGuard; abGuard: ToolGuard } {
  const pwGuard = createBrowserGuard(shop, pw);
  expect(pwGuard(pw.tool('browser_tabs'), { action: 'new', url: shop.baseUrl })).toBeUndefined();
  return { pwGuard, abGuard: createBrowserGuard(shop, ab) };
}
const { pwGuard, abGuard } = guards();

/** A shop whose helper is easy to observe from Node. */
const fakeShop: ShopAdapter = {
  ...karashynyard,
  helperSource: "if (!window.__poo) { window.__poo = { installs: (window.installs = (window.installs || 0) + 1), ping: () => 'pong', echo: (x) => x }; }",
  helperApi: { read: ['ping', 'echo'], write: [] },
};

/** A vm context that looks like a page of `origin`. */
function page(origin = SHOP_ORIGIN): vm.Context {
  const context = vm.createContext({ location: { origin } });
  vm.runInContext('window = globalThis', context);
  return context;
}

describe('browser tool lists per role', () => {
  it.each(['playwright', 'agent-browser'] as const)('%s: nothing types, presses keys, fills forms or touches other tabs', (kind) => {
    for (const role of ['execute', 'qa'] as const) {
      const names = toolset(kind, role).allowedTools.join(' ');
      expect(names).not.toMatch(/_(type|fill|fill_form|press|press_key|hover|select_option|tab_list|tab_switch|reload|resize|run_code_unsafe)\b/);
    }
    expect(toolset(kind, 'execute').allowedTools.some((t) => t.endsWith('click'))).toBe(false);
    expect(toolset(kind, 'qa').allowedTools).toContain(toolset(kind, 'qa').clickTool.name);
  });

  it('blanks the secrets the CLI would otherwise pass on to the browser servers', () => {
    for (const kind of ['playwright', 'agent-browser'] as const) {
      const env = toolset(kind).server.env ?? {};
      for (const key of ['ANTHROPIC_API_KEY', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_API_ROOT', 'TELEGRAM_ALLOWED_USER_ID']) expect(env[key]).toBe('');
    }
  });
});

describe('createBrowserGuard: scope and allow-list', () => {
  it('ignores tools of other servers', () => {
    expect(pwGuard('mcp__agent__ask_user', { question: 'Відправити замовлення?' })).toBeUndefined();
  });

  it.each([
    [pwGuard, pw.tool('browser_run_code_unsafe'), { code: 'async (page) => page.title()' }],
    [pwGuard, pw.tool('browser_file_upload'), { paths: ['/etc/passwd'] }],
    [pwGuard, pw.tool('browser_type'), { target: '@e12', text: 'Олена' }],
    [pwGuard, pw.tool('browser_press_key'), { key: 'Enter' }],
    [abGuard, ab.tool('agent_browser_close'), {}],
    [abGuard, ab.tool('agent_browser_read'), { url: 'https://karashynyard.com.ua/' }],
    [abGuard, ab.tool('agent_browser_fill'), { selector: '@e12', text: 'Олена' }],
    [abGuard, ab.tool('agent_browser_press'), { key: 'Enter' }],
    [abGuard, ab.tool('agent_browser_tab_switch'), { index: 0 }],
    [abGuard, ab.tool('agent_browser_tab_list'), {}],
  ])('denies browser tools outside the allow-list: %#', (guard, tool, input) => {
    expect(guard(tool, input)?.deny).toMatch(/not available/);
  });

  it('allows a plain allowed call unchanged', () => {
    expect(pwGuard(pw.tool('browser_snapshot'), { target: '.t706__cartwin-products' })).toBeUndefined();
    expect(abGuard(ab.tool('agent_browser_click'), { selector: '.t706__carticon-wrapper' })).toBeUndefined();
  });

  it('denies raw CLI flags, file paths and form submission flags', () => {
    expect(abGuard(ab.tool('agent_browser_open'), { url: karashynyard.baseUrl, extraArgs: ['--allow-file-access'] })?.deny).toMatch(/extraArgs/);
    expect(abGuard(ab.tool('agent_browser_screenshot'), { path: '/Users/me/.zshrc' })?.deny).toMatch(/path/);
    expect(pwGuard(pw.tool('browser_take_screenshot'), { scale: 'css', filename: '../../x.png' })?.deny).toMatch(/filename/);
    expect(pwGuard(pw.tool('browser_click'), { target: 'e12', element: 'x', submit: true })?.deny).toMatch(/Submitting/);
  });

  it.each([
    ['session', { session: 'default' }],
    ['namespace', { namespace: 'other' }],
    ['idleTimeout', { idleTimeout: '1s' }],
    ['restore', { restore: true }],
    ['restoreCheckFn', { restoreCheckFn: 'document.title' }],
  ])('denies agent-browser session option %s', (field, extra) => {
    expect(abGuard(ab.tool('agent_browser_get_url'), extra)?.deny).toContain(`"${field}"`);
  });

  it('denies opening a link in a new, unpinned tab', () => {
    expect(abGuard(ab.tool('agent_browser_click'), { selector: 'a', newTab: true })?.deny).toMatch(/newTab/);
  });
});

describe("createBrowserGuard: the user's tabs", () => {
  it('Playwright: nothing runs before this run opened its own tab, then everything allowed does', () => {
    const guard = createBrowserGuard(karashynyard, pw);
    for (const [tool, input] of [
      ['browser_evaluate', { function: '() => window.__poo.status()' }],
      ['browser_navigate', { url: karashynyard.baseUrl }],
      ['browser_snapshot', {}],
    ] as const) {
      expect(guard(pw.tool(tool), input)?.deny).toMatch(/Open your own tab first/);
    }
    expect(guard(pw.tool('browser_tabs'), { action: 'new', url: karashynyard.baseUrl })).toBeUndefined();
    expect(guard(pw.tool('browser_navigate'), { url: karashynyard.cartUrl })).toBeUndefined();
    expect(guard(pw.tool('browser_evaluate'), { function: '() => window.__poo.status()' })?.updatedInput).toBeDefined();
  });

  it.each(['list', 'select', 'close'])('Playwright: never lists, selects or closes tabs (%s)', (action) => {
    expect(pwGuard(pw.tool('browser_tabs'), { action, index: 0 })?.deny).toMatch(/belong to the user/);
    expect(pwGuard(pw.tool('browser_tabs'), { action })?.deny).toMatch(/belong to the user/);
  });

  describe('Playwright through the extension (the session sees only its own tab group)', () => {
    const viaExtension = browserToolset('playwright', {
      role: 'execute',
      connection: { mode: 'extension', profileDir: 'Default' },
      outputDir: '/tmp/poo-test',
      blockedOrigins: [],
      session: 'test',
    });
    const tool = viaExtension.tool;

    it("starts in its own tab: the extension's connect page opened for this run", () => {
      const guard = createBrowserGuard(karashynyard, viaExtension);
      expect(guard(tool('browser_navigate'), { url: karashynyard.baseUrl })).toBeUndefined();
      expect(guard(tool('browser_tabs'), { action: 'list' })?.deny).toMatch(/belong to the user/);
      expect(guard(tool('browser_tabs'), { action: 'select', index: 0 })?.deny).toMatch(/belong to the user/);
    });

    it('closes only its current tab, and nothing runs after that (a new call would reconnect and open a tab)', () => {
      const guard = createBrowserGuard(karashynyard, viaExtension);
      expect(guard(tool('browser_tabs'), { action: 'close', index: 0 })?.deny).toMatch(/belong to the user/);
      expect(guard(tool('browser_tabs'), { action: 'close' })).toBeUndefined();
      for (const [name, input] of [
        ['browser_navigate', { url: karashynyard.baseUrl }],
        ['browser_tabs', { action: 'new', url: karashynyard.baseUrl }],
        ['browser_snapshot', {}],
      ] as const) {
        expect(guard(tool(name), input)?.deny).toMatch(/tab is closed/);
      }
    });
  });

  it('Playwright over CDP never closes a tab, not even the current one', () => {
    expect(pwGuard(pw.tool('browser_tabs'), { action: 'close' })?.deny).toMatch(/belong to the user/);
  });

  it('agent-browser works in its own pinned tab from the first call', () => {
    expect(createBrowserGuard(karashynyard, ab)(ab.evalTool.name, { script: 'window.__poo.status()' })?.updatedInput).toBeDefined();
  });
});

describe('createBrowserGuard: navigation allow-list', () => {
  it.each([
    'https://karashynyard.com.ua/',
    'https://karashynyard.com.ua/#opencart',
    'karashynyard.com.ua/',
    'about:blank',
  ])('allows %s', (url) => {
    expect(pwGuard(pw.tool('browser_navigate'), { url })).toBeUndefined();
    expect(createBrowserGuard(karashynyard, pw)(pw.tool('browser_tabs'), { action: 'new', url })).toBeUndefined();
    expect(abGuard(ab.tool('agent_browser_open'), { url })).toBeUndefined();
  });

  it.each([
    'https://example.com/',
    'https://karashynyard.com.ua.evil.com/',
    'https://karashynyard.com.ua@evil.com/',
    'http://karashynyard.com.ua/',
    'https://forms.tildaapi.one/procces/',
    'javascript:alert(1)',
    'data:text/html,<h1>x</h1>',
    'file:///etc/passwd',
  ])('denies %s', (url) => {
    expect(pwGuard(pw.tool('browser_navigate'), { url })?.deny).toMatch(/not allowed/);
    expect(pwGuard(pw.tool('browser_tabs'), { action: 'new', url })?.deny).toMatch(/not allowed/);
    expect(abGuard(ab.tool('agent_browser_open'), { url })?.deny).toMatch(/not allowed/);
  });

  it('allows opening a blank tab without a url', () => {
    expect(pwGuard(pw.tool('browser_tabs'), { action: 'new' })).toBeUndefined();
    expect(abGuard(ab.tool('agent_browser_open'), {})).toBeUndefined();
  });
});

describe('createBrowserGuard: page scripts are single helper calls', () => {
  it.each([
    '() => window.__poo.status()',
    'window.__poo.readCart()',
    'async () => await window.__poo.setQty("Філе зі стегна індички, 1 кг", 2)',
    '() => { return window.__poo.find("Шиї курки, 1 кг"); }',
    '__poo.readModal();',
    '() => window.__poo.setQty("a), evil(", 0)',
  ])('allows %s', (code) => {
    expect(pwGuard(pw.evalTool.name, { function: code })?.updatedInput).toBeDefined();
    expect(abGuard(ab.evalTool.name, { script: code })?.updatedInput).toBeDefined();
  });

  it.each([
    '() => { location.href = "https://example.com" }',
    'window.open("https://example.com")',
    '() => document.title',
    'window.__poo.setQty("x", 1); fetch("https://example.com")',
    "window.__poo.setQty('single quotes', 1)",
    'window.__poo.setQty(name, 1)',
    'window.__poo.setQty("x", 1.5)',
    "window.__poo['set' + 'Qty']('x', 0)",
    'window.__poo.openCart()',
    'var f = document.querySelector(".t706__cartwin form"); f.querySelector("button").click()',
    'document.querySelector(".t706__product-del").click()',
  ])('denies %s', (code) => {
    expect(pwGuard(pw.evalTool.name, { function: code })?.deny).toBeTruthy();
    expect(abGuard(ab.evalTool.name, { script: code })?.deny).toBeTruthy();
  });

  it('parses the call and its literal arguments', () => {
    expect(parseHelperCall('() => window.__poo.setQty("Філе", 2)')).toEqual({ method: 'setQty', args: ['Філе', 2] });
    expect(parseHelperCall('window.__poo.status()')).toEqual({ method: 'status', args: [] });
    expect(parseHelperCall('window.__poo.status(); window.__poo.readCart()')).toBeUndefined();
  });
});

describe('createBrowserGuard: order form patterns', () => {
  it.each([
    [pwGuard, pw.evalTool.name, { function: '() => window.__poo.find("Відправити замовлення")' }],
    [abGuard, ab.evalTool.name, { script: 'document.querySelector("form").requestSubmit()' }],
    [pwGuard, pw.tool('browser_click'), { target: '.t706__orderform .t-submit', element: 'order button' }],
    [pwGuard, pw.tool('browser_click'), { target: 'e3647', element: 'Відправити замовлення button' }],
    [abGuard, ab.evalTool.name, { script: 'fetch("https://forms2.tildacdn.com/procces/", { method: "POST" })' }],
  ])('denies order-form input %#', (guard, tool, input) => {
    expect(guard(tool, input)?.deny).toMatch(/karashynyard safety rules/);
  });
});

describe('createBrowserGuard: helper injection', () => {
  it('Playwright: rewrites only `function`, keeps other fields, and the result behaves like the original', async () => {
    const { pwGuard: guard } = guards(fakeShop);
    const input = { function: '() => window.__poo.ping()', element: 'cart', target: '.t706__cartwin' };
    const updated = guard(pw.evalTool.name, input)?.updatedInput as typeof input;
    expect(updated.element).toBe('cart');
    expect(updated.target).toBe('.t706__cartwin');
    expect(updated.function).toContain(fakeShop.helperSource);
    expect(updated.function).toContain(input.function);
    expect(input.function).toBe('() => window.__poo.ping()'); // the caller's object is not mutated

    // Playwright MCP evaluates `(${function})` and calls the value (with the element when targeted).
    const run = (code: string, origin?: string) =>
      Promise.resolve().then(() => vm.runInContext(`(${withHelper('playwright', fakeShop, code)})`, page(origin))(undefined) as unknown);
    await expect(run('() => window.__poo.ping()')).resolves.toBe('pong');
    await expect(run('window.__poo.ping() + "!"')).resolves.toBe('pong!');
    await expect(run('async () => { await null; return 42 }')).resolves.toBe(42);
    await expect(run('() => 1 // trailing comment')).resolves.toBe(1);
    await expect(run('() => window.__poo.ping()', 'https://mail.example.com')).rejects.toThrow(/not on the shop/);
  });

  it('agent-browser: prepends the helper to `script` and keeps classic-script semantics', async () => {
    const { abGuard: guard } = guards(fakeShop);
    const input = { script: 'window.__poo.echo("x")', allowedDomains: ['karashynyard.com.ua'] };
    const updated = guard(ab.evalTool.name, input)?.updatedInput as typeof input;
    expect(updated.allowedDomains).toEqual(['karashynyard.com.ua']);
    expect(updated.script).toContain(fakeShop.helperSource);
    expect(updated.script.endsWith(input.script)).toBe(true);

    // agent-browser returns the completion value of a classic script and awaits a returned promise.
    const context = page();
    const run = (script: string) => Promise.resolve(vm.runInContext(withHelper('agent-browser', fakeShop, script), context));
    await expect(run('window.__poo.ping()')).resolves.toBe('pong');
    await expect(run('var n = 2; n * 21')).resolves.toBe(42);
    await expect(run('Promise.resolve(window.__poo.ping())')).resolves.toBe('pong');
    expect(vm.runInContext('window.installs', context)).toBe(1); // the helper is installed once
    expect(() => vm.runInContext(withHelper('agent-browser', fakeShop, 'window.__poo.ping()'), page('null'))).toThrow(/not on the shop/);
  });

  it('does not rewrite other tools', () => {
    expect(pwGuard(pw.tool('browser_click'), { target: '.t706__carticon-wrapper', element: 'cart icon' })).toBeUndefined();
  });
});
