import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { readOnlyBasketGuard } from '../src/core/qa/guard.js';
import { createBrowserGuard } from '../src/core/browser/guard.js';
import type { ToolGuard } from '../src/core/browser/guard.js';
import { browserToolset, type BrowserMode, type BrowserRole, type BrowserToolset } from '../src/core/browser/toolset.js';
import { getShop } from '../src/core/shops/index.js';
import { karashynyard } from '../src/core/shops/karashynyard/index.js';

const toolset = (role: BrowserRole, mode: BrowserMode) => browserToolset({ role, mode });

/** The guard of one agent run that has opened its own tab (the first step of both playbooks). */
function openedGuard(tools: BrowserToolset, wrap: (shopGuard: ToolGuard) => ToolGuard = (g) => g): ToolGuard {
  const guard = wrap(createBrowserGuard(karashynyard, tools));
  if (!tools.startsInOwnTab) guard(tools.tool('browser_tabs'), { action: 'new', url: karashynyard.baseUrl });
  return guard;
}
const VARIANTS: Array<{ name: string; mode: BrowserMode; firstTool: string }> = [
  { name: 'Playwright over CDP', mode: 'cdp', firstTool: 'browser_tabs' },
  { name: 'Playwright through the extension', mode: 'extension', firstTool: 'browser_navigate' },
];

/** Tool calls rendered in a playbook as `tool` `{json args}`. */
function renderedCalls(markdown: string): Array<{ tool: string; input: Record<string, unknown> }> {
  return [...markdown.matchAll(/`(playwright__\w+)` `(\{[^`]*\})`/g)].map((m) => ({ tool: m[1]!, input: JSON.parse(m[2]!) }));
}

const CHECKOUT = { name: 'Тарас Тестовий', phone: '+380671234567', delivery: 'Доставка Новою поштою', address: 'вул. Тестова 1, Київ' };

const forbidden = (text: string) => karashynyard.forbiddenPatterns.some((p) => text.search(p) !== -1);

describe('karashynyard adapter', () => {
  it('is registered and stays on the shop origin', () => {
    expect(getShop('karashynyard')).toBe(karashynyard);
    expect(karashynyard.allowedOrigins).toEqual(['https://karashynyard.com.ua']);
    expect(new URL(karashynyard.baseUrl).origin).toBe('https://karashynyard.com.ua');
    expect(karashynyard.cartUrl).toBe('https://karashynyard.com.ua/#opencart');
    expect(karashynyard.blockedOrigins).toContain('https://forms.tildaapi.one');
    expect(karashynyard.blockedOrigins).toContain('https://forms2.tildacdn.com');
    expect(karashynyard.cartOpeners).toEqual(['.t706__carticon-wrapper', 'a.t-menuwidgeticons__link_cart']);
  });
});

describe.each(VARIANTS)('playbooks for $name', ({ mode, firstTool }) => {
  const tools: BrowserToolset = toolset('execute', mode);
  const qaTools: BrowserToolset = toolset('qa', mode);
  const execute = karashynyard.executePlaybook(tools);
  const qa = karashynyard.qaPlaybook(qaTools);

  it('use only tools the agent is allowed to call', () => {
    for (const [markdown, allowed] of [
      [execute, tools.allowedTools],
      [qa, qaTools.allowedTools],
    ] as const) {
      const names = [...markdown.matchAll(/playwright__\w+/g)].map((m) => m[0]);
      expect(names.length).toBeGreaterThan(5);
      for (const name of names) expect(allowed).toContain(name);
    }
  });

  it("render calls that the agent's guard lets through", () => {
    const executeGuard = openedGuard(tools);
    const qaGuard = openedGuard(qaTools, (shopGuard) => readOnlyBasketGuard(qaTools, karashynyard, shopGuard));
    const calls = [
      ...renderedCalls(execute).map((c) => ({ ...c, guard: executeGuard })),
      ...renderedCalls(qa).map((c) => ({ ...c, guard: qaGuard })),
    ];
    expect(calls.length).toBeGreaterThan(10);
    for (const { tool, input, guard } of calls) expect(guard(tool, input)?.deny, `${tool} ${JSON.stringify(input)}`).toBeUndefined();
  });

  it('never tell an agent to switch tabs; close only its own tab, as the last call, when it sees only its own tabs', () => {
    for (const playbook of [execute, qa]) {
      const calls = renderedCalls(playbook);
      const tabCalls = calls.filter((c) => c.tool === tools.tool('browser_tabs'));
      const closes = tabCalls.filter((c) => c.input.action === 'close');
      for (const { input } of tabCalls) expect(input.action === 'new' || (input.action === 'close' && input.index === undefined)).toBe(true);
      expect(closes).toHaveLength(tools.seesOnlyOwnTabs ? 1 : 0);
      if (closes.length) expect(calls.at(-1)).toEqual(closes[0]);
    }
    expect(execute + qa).not.toMatch(/"select"|"list"/);
  });

  it('render the eval tool with the right code field', () => {
    const evals = renderedCalls(execute).filter((c) => c.tool === tools.evalTool.name);
    const setQty = evals.find((c) => String(c.input[tools.evalTool.codeField]).includes('setQty'));
    expect(setQty?.input).toEqual({ function: '() => window.__poo.setQty("Філе зі стегна індички, 1 кг", 2)' });
  });

  it('Execute and QA put their own tab on the shop first; Execute re-checks with readCart', () => {
    for (const playbook of [execute, qa]) {
      const [first] = renderedCalls(playbook.slice(playbook.indexOf('### Procedure')));
      expect(first?.tool).toBe(tools.tool(firstTool));
      expect(first?.input.url).toBe(karashynyard.baseUrl);
      expect(createBrowserGuard(karashynyard, tools)(first!.tool, first!.input)?.deny).toBeUndefined();
    }
    expect(execute).toContain('window.__poo.readCart()');
  });

  it('QA clicks the cart icon, then falls back to the header icon and the cart URL', () => {
    const clicks = renderedCalls(qa).filter((c) => c.tool === qaTools.clickTool.name);
    expect(clicks.map((c) => c.input.target)).toEqual(['.t706__carticon-wrapper', 'a.t-menuwidgeticons__link_cart']);
    expect(renderedCalls(qa).some((c) => c.input.url === karashynyard.cartUrl)).toBe(true);
    expect(qa).toContain('window.__poo.readModal()');
    expect(qa).toContain('.t706__cartwin-products');
  });
});

describe.each(VARIANTS)('Execute playbook that fills the order form, for $name', ({ mode }) => {
  const tools = toolset('execute', mode);
  const playbook = karashynyard.executePlaybook(tools, { fillOrderForm: true });
  const guard = () => {
    const g = createBrowserGuard(karashynyard, tools, { checkout: CHECKOUT });
    if (!tools.startsInOwnTab) g(tools.tool('browser_tabs'), { action: 'new', url: karashynyard.baseUrl });
    return g;
  };

  it('fills the form without arguments and reads it back, after the basket check', () => {
    const codes = renderedCalls(playbook).map((c) => String(c.input[tools.evalTool.codeField] ?? ''));
    const fill = codes.indexOf('() => window.__poo.fillOrderForm()');
    expect(fill).toBeGreaterThan(codes.lastIndexOf('() => window.__poo.readCart()'));
    expect(codes.indexOf('() => window.__poo.readOrderForm()')).toBeGreaterThan(fill);
  });

  it('renders only calls its guard lets through, and never closes the tab that holds the form', () => {
    const g = guard();
    for (const { tool, input } of renderedCalls(playbook)) expect(g(tool, input)?.deny, `${tool} ${JSON.stringify(input)}`).toBeUndefined();
    expect(renderedCalls(playbook).some((c) => c.input.action === 'close')).toBe(false);
    expect(playbook).toMatch(/Keep your tab open/);
  });

  it('still forbids sending the order and typing personal data', () => {
    expect(playbook).toMatch(/never\s+press "Відправити замовлення"/);
    expect(playbook).toMatch(/never type personal data/);
  });

  it('is the plain basket playbook without the option', () => {
    expect(karashynyard.executePlaybook(tools)).not.toContain('fillOrderForm');
  });
});

describe('karashynyard forbiddenPatterns', () => {
  it.each([
    'window.__poo.setQty("Філе зі стегна індички, 1 кг", 2)',
    'window.__poo.setQty("Горіхова паста з фунндуком 350 г", 0)',
    'window.__poo.find("Котлети з фермерської індички та кролика, 900 г")',
    'window.__poo.readCart()',
    'window.__poo.readModal()',
    'window.__poo.status()',
    'window.__poo.fillOrderForm()',
    'window.__poo.readOrderForm()',
    '.t706__carticon-wrapper',
    'a.t-menuwidgeticons__link_cart',
    '.t706__cartwin.t706__cartwin_showed',
    '.t706__cartwin-products',
    'https://karashynyard.com.ua/#opencart',
  ])('do not match normal usage: %s', (text) => {
    expect(forbidden(text)).toBe(false);
  });

  it.each([
    '.t706__orderform input',
    'Відправити замовлення',
    'form#form638772399',
    'button[type=submit]',
    '.t-submit',
    'document.forms[0].submit()',
    'form.requestSubmit()',
    'window.tildaForm.send(form)',
    'fetch("https://forms.tildaapi.one/procces/")',
    'fetch("https://forms2.tildacdn.com/procces/")',
    'input.t-input[name="Ваше імя"]',
    'Подарувати тушонку ЗСУ',
  ])('match the order form: %s', (text) => {
    expect(forbidden(text)).toBe(true);
  });

  it('do not match the in-page helper itself', () => {
    expect(forbidden(karashynyard.helperSource)).toBe(false);
  });
});

describe('karashynyard helperSource', () => {
  const install = (tcart: unknown) => {
    const context = vm.createContext({
      setTimeout,
      localStorage: { getItem: (key: string) => (key === 'tcart' ? JSON.stringify(tcart) : null) },
      document: { readyState: 'complete', querySelectorAll: () => [], querySelector: () => null },
      location: { href: 'https://karashynyard.com.ua/' },
    });
    vm.runInContext('window = globalThis', context);
    vm.runInContext(karashynyard.helperSource, context);
    return context as unknown as { window: { __poo: Record<string, (...args: unknown[]) => unknown> } };
  };

  it('defines window.__poo once per version', () => {
    const context = install(null);
    const first = context.window.__poo;
    vm.runInContext(karashynyard.helperSource, context as unknown as vm.Context);
    expect(context.window.__poo).toBe(first);
    expect(Object.keys(first).sort()).toEqual([
      'closeCart',
      'fillOrderForm',
      'find',
      'openCart',
      'readCart',
      'readModal',
      'readOrderForm',
      'setQty',
      'status',
      'version',
    ]);
  });

  it('readOrderForm reports a missing form instead of throwing', () => {
    const { window } = install(null);
    expect(window.__poo.readOrderForm!()).toEqual({ found: false, name: '', phone: '', delivery: null, address: '' });
  });

  it('readCart ignores deleted and empty lines and sums units and amounts', () => {
    const { window } = install({
      products: [
        { name: 'Філе зі стегна індички, 1 кг', price: 665, quantity: 2, amount: 1330, sku: '1' },
        { name: 'Печінка курочки, 500 г', price: 360, quantity: 1, amount: 360, sku: '408', deleted: 'yes' },
        {},
        { name: 'Горіхова паста з фунндуком 350 г', price: 850, quantity: 1, amount: 850, sku: '513' },
      ],
    });
    expect(window.__poo.readCart!()).toEqual({
      lines: [
        { name: 'Філе зі стегна індички, 1 кг', qty: 2, unitPrice: 665, amount: 1330, sku: '1' },
        { name: 'Горіхова паста з фунндуком 350 г', qty: 1, unitPrice: 850, amount: 850, sku: '513' },
      ],
      units: 3,
      total: 2180,
    });
  });

  it('status waits for the page, then reports not ready before Tilda initialises the cart', async () => {
    const { window } = install(null);
    await expect(window.__poo.status!(1)).resolves.toEqual({ ready: false, url: 'https://karashynyard.com.ua/', cartLines: 0, units: 0, total: 0 });
  });
});
