/**
 * Execute/QA playbooks for karashynyard.com.ua, rendered with the exact Playwright MCP tool names and argument
 * shapes the agent has.
 */
import type { BrowserToolset } from '../../browser/toolset.js';

export interface ShopUrls {
  baseUrl: string;
  cartUrl: string;
}

const CART_ROWS = '.t706__cartwin-products';
/** The floating basket icon at the top right, and the header one (narrow windows): the only clicks QA makes. */
export const CART_ICON = '.t706__carticon-wrapper';
export const HEADER_CART_ICON = 'a.t-menuwidgeticons__link_cart';
const EXAMPLE_NAME = 'Філе зі стегна індички, 1 кг';

/** One rendered tool call: `tool` + JSON arguments. */
const call = (tool: string, args: Record<string, unknown>) => `\`${tool}\` \`${JSON.stringify(args)}\``;
const NOT_USER_TABS = "never use, select or close the user's tabs";

/** The handful of browser actions the playbooks need. */
interface Actions {
  evalCall(expr: string): string;
  /** The first step of both playbooks: the sentence and the call that put this run's own tab on `url`. */
  openOwnTab(url: string): string;
  /** The call that closes the run's own tab, when the agent may close it (it sees only its own tabs). */
  closeOwnTab?: string;
  navigate(url: string): string;
  click(selector: string, element: string): string;
  pause: string;
  waitCartWindow: string;
  readText(selector: string): string;
}

function actions(tools: BrowserToolset): Actions {
  const t = tools.tool;
  const evalCall = (expr: string) => call(tools.evalTool.name, { function: `() => ${expr}` });
  return {
    evalCall,
    // Through the extension the current tab is the connect page opened for this run: reuse it rather than leave
    // it behind as a second tab (the attached tab keeps the extension's service worker alive on its own).
    openOwnTab: (url: string) =>
      tools.startsInOwnTab
        ? `Load the shop in your own tab, the current one, which was opened for this run (${NOT_USER_TABS}): ${call(t('browser_navigate'), { url })}`
        : `Open your own tab first (${NOT_USER_TABS}): ${call(t('browser_tabs'), { action: 'new', url })}`,
    closeOwnTab: tools.seesOnlyOwnTabs ? call(t('browser_tabs'), { action: 'close' }) : undefined,
    navigate: (url: string) => call(t('browser_navigate'), { url }),
    click: (selector: string, element: string) => call(t('browser_click'), { target: selector, element }),
    pause: call(t('browser_wait_for'), { time: 2 }),
    waitCartWindow: `${call(t('browser_wait_for'), { time: 1 })} then ${evalCall('window.__poo.readModal()')}, until \`open\` is true (at most 3 times)`,
    readText: (selector: string) => call(t('browser_snapshot'), { target: selector }),
  };
}

/** The last step of both playbooks: close the run's own tab when allowed, else leave it as `keepOpen` says. */
function lastStep(a: Actions, keepOpen: string): string {
  if (!a.closeOwnTab) return `${keepOpen} Never close tabs.`;
  return `Close your tab as your last browser call, also after a failure: ${a.closeOwnTab}. Every browser tool is blocked after it; then give your result.`;
}

const SAFETY = `Never touch the order form inside the cart window (name, phone, delivery, address, "Подарувати тушонку ЗСУ",
"Відправити замовлення") and never type personal data: you only prepare the basket, the user orders. Tool calls that
mention the order form or submitting are blocked. Never click product titles or images: on this site they also add to
the basket.`;

export function renderExecutePlaybook(tools: BrowserToolset, urls: ShopUrls): string {
  const a = actions(tools);
  const setQtyExample = a.evalCall(`window.__poo.setQty(${JSON.stringify(EXAMPLE_NAME)}, 2)`);
  return `## Shop playbook: karashynyard.com.ua (Tilda)

The basket is the shop's Tilda cart. It exists only in this browser profile (localStorage), so every change is the
user's real basket. Tilda ADDS quantities when a product is added again, so never press "До кошика" yourself: change
quantities only with \`window.__poo.setQty\`, which makes the basket contain exactly the requested quantity.
${SAFETY}

### In-page helper
Every \`${tools.evalTool.name}\` call already has \`window.__poo\` loaded (it is injected for you; never paste or
redefine it). One method per call:
- \`window.__poo.status()\` → \`{ready, url, cartLines, units, total}\` (waits up to 10 s for the page to be ready)
- \`window.__poo.find(name)\` → \`{found, name, price, sku, selector}\` or \`{found: false, candidates}\` (up to 5 closest names)
- \`window.__poo.setQty(name, qty)\` → \`{status: "ok"|"not_found"|"failed", name, before, after, detail?}\`. \`qty\` is the
  absolute target (0 removes the line). It waits for Tilda itself: ~1 s per add, ~5 s per removal, longer
  while the tab is in the background. Wait for the result; never call it again while it runs.
- \`window.__poo.readCart()\` → \`{lines: [{name, qty, unitPrice, amount, sku}], units, total}\` (what the basket holds)

A page script is exactly one helper call and nothing else. Write product names as JSON strings inside the code,
exactly as given in the task, e.g. ${setQtyExample}

### Procedure
1. ${a.openOwnTab(urls.baseUrl)}
2. Wait until the page is ready: ${a.evalCall('window.__poo.status()')} (it waits by itself). If \`ready\` is false,
   ${a.pause} and call it once more; if it is still false, report every operation as \`failed\` with detail
   "the shop page did not load" (after step 6).
3. Read the basket before changing it: ${a.evalCall('window.__poo.readCart()')}
4. For each operation make exactly one setQty call with the exact name and the targetQty.
   - \`ok\`: done, actualQty = \`after\`.
   - \`not_found\`: do not pick another product yourself; report \`not_found\` with the closest names from \`detail\`.
   - \`failed\`: repeat the same call once; if it fails again report \`failed\` with \`after\` and \`detail\`.
5. Verify with ${a.evalCall('window.__poo.readCart()')}: every requested name must have exactly its targetQty
   (0 = no line). Fix a mismatch with one more setQty call. Use this final read for the basket in your result.
6. ${lastStep(a, 'Leave your tab open.')}
`;
}

export function renderQaPlaybook(tools: BrowserToolset, urls: ShopUrls): string {
  const a = actions(tools);
  return `## Shop playbook: karashynyard.com.ua (Tilda)

You only LOOK at the basket like the user would. Never change it: no "До кошика", no plus/minus/delete in the cart
window, no \`setQty\`. ${SAFETY}

### In-page helper
Every \`${tools.evalTool.name}\` call already has \`window.__poo\` loaded (injected for you; never paste it):
- \`window.__poo.status()\` → \`{ready, url, cartLines, units, total}\` (waits up to 10 s for the page to be ready)
- \`window.__poo.readModal()\` → \`{open, lines: [{name, qty, amount}], total}\` parsed from the visible cart window
- \`window.__poo.readCart()\` → \`{lines: [{name, qty, unitPrice, amount, sku}], units, total}\` from the stored basket

A page script is exactly one of these calls and nothing else.

### Procedure
1. ${a.openOwnTab(urls.baseUrl)}
2. Wait until ready: ${a.evalCall('window.__poo.status()')} (it waits by itself). If \`ready\` is false, ${a.pause} and
   call it once more; if it is still false, report what ${a.evalCall('window.__poo.readCart()')} returns with
   \`modalOpened: false\` (after step 6). If \`cartLines\` is 0 the basket is empty and there is nothing to open:
   call ${a.evalCall('window.__poo.readCart()')} once and go to step 6.
3. Open the basket the way the user does, by clicking the cart icon at the top right: ${a.click(CART_ICON, 'cart icon')}
   If that fails, click the header cart icon: ${a.click(HEADER_CART_ICON, 'header cart icon')}
   If that fails too, load ${a.navigate('about:blank')} and then ${a.navigate(urls.cartUrl)} (the cart opens only on a full page load).
4. Wait for the cart window: ${a.waitCartWindow}.
5. Read the basket three ways:
   - what the user sees: ${a.readText(CART_ROWS)} (names, quantities, line amounts),
   - ${a.evalCall('window.__poo.readModal()')},
   - ${a.evalCall('window.__poo.readCart()')}.
   Copy every name character for character as the page shows it, including the shop's own typos, and do not judge
   the basket: the system compares the page data with the order. If the three views disagree, report the cart
   window's lines and mention the disagreement.
6. ${lastStep(a, 'Leave the cart window and your tab open: the user may look at them.')}
`;
}
