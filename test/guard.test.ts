import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { createBrowserGuard, parseHelperCall, withHelper, type ToolGuard } from '../src/core/browser/guard.js';
import { browserToolset, type BrowserRole } from '../src/core/browser/toolset.js';
import { karashynyard } from '../src/core/shops/karashynyard/index.js';
import type { ShopAdapter } from '../src/core/shops/types.js';

const SHOP_ORIGIN = 'https://karashynyard.com.ua';
const toolset = (role: BrowserRole = 'execute') => browserToolset({ role, mode: 'cdp' });
const pw = toolset('qa');

/** A guard (attached over CDP) whose run has already opened its own tab. */
function openedGuard(shop: ShopAdapter = karashynyard): ToolGuard {
  const guard = createBrowserGuard(shop, pw);
  expect(guard(pw.tool('browser_tabs'), { action: 'new', url: shop.baseUrl })).toBeUndefined();
  return guard;
}
const pwGuard = openedGuard();

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
  it('nothing types, presses keys, fills forms or touches other tabs; only QA clicks', () => {
    for (const role of ['execute', 'qa'] as const) {
      const names = toolset(role).allowedTools.join(' ');
      expect(names).not.toMatch(/_(type|fill|fill_form|press|press_key|hover|select_option|reload|resize|run_code_unsafe|file_upload)\b/);
    }
    expect(toolset('execute').allowedTools.some((t) => t.endsWith('click'))).toBe(false);
    expect(toolset('qa').allowedTools).toContain(toolset('qa').clickTool.name);
  });
});

describe('createBrowserGuard: scope and allow-list', () => {
  it('ignores tools of other servers', () => {
    expect(pwGuard('poo_ask_user', { question: 'Відправити замовлення?' })).toBeUndefined();
    expect(pwGuard('mcp__playwright__browser_evaluate', { function: '() => document.title' })).toBeUndefined();
  });

  it.each([
    [pwGuard, pw.tool('browser_run_code_unsafe'), { code: 'async (page) => page.title()' }],
    [pwGuard, pw.tool('browser_file_upload'), { paths: ['/etc/passwd'] }],
    [pwGuard, pw.tool('browser_type'), { target: '@e12', text: 'Олена' }],
    [pwGuard, pw.tool('browser_press_key'), { key: 'Enter' }],
    [pwGuard, pw.tool('browser_fill_form'), { fields: [] }],
  ])('denies browser tools outside the allow-list: %#', (guard, tool, input) => {
    expect(guard(tool, input)?.deny).toMatch(/not available/);
  });

  it('allows a plain allowed call unchanged', () => {
    expect(pwGuard(pw.tool('browser_snapshot'), { target: '.t706__cartwin-products' })).toBeUndefined();
  });

  it('denies file paths and form submission flags', () => {
    expect(pwGuard(pw.tool('browser_snapshot'), { path: '/Users/me/.zshrc' })?.deny).toMatch(/path/);
    expect(pwGuard(pw.tool('browser_take_screenshot'), { scale: 'css', filename: '../../x.png' })?.deny).toMatch(/filename/);
    expect(pwGuard(pw.tool('browser_click'), { target: 'e12', element: 'x', submit: true })?.deny).toMatch(/Submitting/);
  });
});

describe("createBrowserGuard: the user's tabs", () => {
  it('over CDP: nothing runs before this run opened its own tab, then everything allowed does', () => {
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

  it.each(['list', 'select', 'close'])('never lists, selects or closes tabs (%s)', (action) => {
    expect(pwGuard(pw.tool('browser_tabs'), { action, index: 0 })?.deny).toMatch(/belong to the user/);
    expect(pwGuard(pw.tool('browser_tabs'), { action })?.deny).toMatch(/belong to the user/);
  });

  describe('Playwright through the extension (the session sees only its own tab group)', () => {
    const viaExtension = browserToolset({ role: 'execute', mode: 'extension' });
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

  it('over CDP never closes a tab, not even the current one', () => {
    expect(pwGuard(pw.tool('browser_tabs'), { action: 'close' })?.deny).toMatch(/belong to the user/);
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
  });

  it('allows opening a blank tab without a url', () => {
    expect(pwGuard(pw.tool('browser_tabs'), { action: 'new' })).toBeUndefined();
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
    [pwGuard, pw.evalTool.name, { function: '() => document.querySelector("form").requestSubmit()' }],
    [pwGuard, pw.tool('browser_click'), { target: '.t706__orderform .t-submit', element: 'order button' }],
    [pwGuard, pw.tool('browser_click'), { target: 'e3647', element: 'Відправити замовлення button' }],
    [pwGuard, pw.evalTool.name, { function: '() => fetch("https://forms2.tildacdn.com/procces/", { method: "POST" })' }],
  ])('denies order-form input %#', (guard, tool, input) => {
    expect(guard(tool, input)?.deny).toMatch(/karashynyard safety rules/);
  });
});

describe('createBrowserGuard: the order form', () => {
  const checkout = { name: 'Тарас Тестовий', phone: '+380671234567', delivery: 'Доставка Новою поштою', address: 'вул. Тестова 1, Київ' };
  /** Echoes the arguments fillOrderForm gets in the page. */
  const formShop: ShopAdapter = {
    ...karashynyard,
    helperSource: 'window.__poo = { fillOrderForm: (...args) => args, readOrderForm: () => ({ found: true }) };',
    helperApi: { read: ['readOrderForm'], write: ['fillOrderForm'] },
  };
  const fillGuard = (shop: ShopAdapter = formShop, opts = { checkout }) => {
    const guard = createBrowserGuard(shop, pw, opts);
    guard(pw.tool('browser_tabs'), { action: 'new', url: shop.baseUrl });
    return guard;
  };

  it("passes the configured details to fillOrderForm: the model never types them", async () => {
    const updated = fillGuard()(pw.evalTool.name, { function: '() => window.__poo.fillOrderForm()' })?.updatedInput as { function: string };
    expect(updated.function).toContain(`window.__poo.fillOrderForm("Тарас Тестовий", "+380671234567", "Доставка Новою поштою", "вул. Тестова 1, Київ")`);
    const args = await Promise.resolve(vm.runInContext(`(${updated.function})`, page())(undefined));
    expect(args).toEqual([checkout.name, checkout.phone, checkout.delivery, checkout.address]);
  });

  it('denies arguments from the model, and filling when no details are configured', () => {
    expect(fillGuard()(pw.evalTool.name, { function: 'window.__poo.fillOrderForm("Хтось", "+380000000000", "x", "y")' })?.deny).toMatch(/without arguments/);
    expect(fillGuard(formShop, {} as { checkout: typeof checkout })(pw.evalTool.name, { function: 'window.__poo.fillOrderForm()' })?.deny).toMatch(/not set up/);
    expect(pwGuard(pw.evalTool.name, { function: 'window.__poo.fillOrderForm()' })?.deny).toMatch(/not set up/);
  });

  it('still blocks direct access to the form and its submit button', () => {
    const guard = fillGuard(karashynyard);
    expect(guard(pw.evalTool.name, { function: '() => window.__poo.readOrderForm()' })?.updatedInput).toBeDefined();
    expect(guard(pw.tool('browser_click'), { target: '.t706__orderform .t-submit', element: 'order button' })?.deny).toMatch(/safety rules/);
    expect(guard(pw.evalTool.name, { function: '() => document.forms[0].requestSubmit()' })?.deny).toMatch(/safety rules/);
  });

  it('through the extension, keeps the tab that holds the filled form', () => {
    const viaExtension = browserToolset({ role: 'execute', mode: 'extension' });
    const guard = createBrowserGuard(karashynyard, viaExtension, { checkout });
    expect(guard(viaExtension.tool('browser_tabs'), { action: 'close' })?.deny).toMatch(/Keep your tab open/);
    expect(guard(viaExtension.tool('browser_navigate'), { url: karashynyard.baseUrl })).toBeUndefined();
  });
});

describe('createBrowserGuard: helper injection', () => {
  it('rewrites only `function`, keeps other fields, and the result behaves like the original', async () => {
    const guard = openedGuard(fakeShop);
    const input = { function: '() => window.__poo.ping()', element: 'cart', target: '.t706__cartwin' };
    const updated = guard(pw.evalTool.name, input)?.updatedInput as typeof input;
    expect(updated.element).toBe('cart');
    expect(updated.target).toBe('.t706__cartwin');
    expect(updated.function).toContain(fakeShop.helperSource);
    expect(updated.function).toContain(input.function);
    expect(input.function).toBe('() => window.__poo.ping()'); // the caller's object is not mutated

    // Playwright MCP evaluates `(${function})` and calls the value (with the element when targeted).
    const run = (code: string, origin?: string) =>
      Promise.resolve().then(() => vm.runInContext(`(${withHelper(fakeShop, code)})`, page(origin))(undefined) as unknown);
    await expect(run('() => window.__poo.ping()')).resolves.toBe('pong');
    await expect(run('window.__poo.ping() + "!"')).resolves.toBe('pong!');
    await expect(run('async () => { await null; return 42 }')).resolves.toBe(42);
    await expect(run('() => 1 // trailing comment')).resolves.toBe(1);
    await expect(run('() => window.__poo.ping()', 'https://mail.example.com')).rejects.toThrow(/not on the shop/);
  });

  it('does not rewrite other tools', () => {
    expect(pwGuard(pw.tool('browser_click'), { target: '.t706__carticon-wrapper', element: 'cart icon' })).toBeUndefined();
  });
});
