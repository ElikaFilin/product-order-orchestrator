import { describeHelperCalls, parseHelperCall, type ToolGuard } from '../browser/guard.js';
import type { BrowserToolset } from '../browser/toolset.js';
import type { ShopAdapter } from '../shops/types.js';

/**
 * QA only observes, like the user: its page scripts may only call the helper's read methods, and the only
 * thing it may click is the basket icon. Everything else is denied here, then the shop guard applies.
 * Checked on the agent's own code, before the shop guard prepends the helper source.
 */
export function readOnlyBasketGuard(
  toolset: Pick<BrowserToolset, 'evalTool' | 'clickTool'>,
  shop: Pick<ShopAdapter, 'helperApi' | 'cartOpeners'>,
  shopGuard: ToolGuard,
): ToolGuard {
  return (toolName, input) => {
    if (toolName === toolset.evalTool.name) {
      const call = parseHelperCall(String(input[toolset.evalTool.codeField] ?? ''));
      if (!call || !shop.helperApi.read.includes(call.method)) {
        return {
          deny: `QA is read-only: it must not change the basket. Page scripts may only read it: ${describeHelperCalls(shop.helperApi.read)}.`,
        };
      }
    } else if (toolName === toolset.clickTool.name) {
      const target = input[toolset.clickTool.selectorField];
      if (typeof target !== 'string' || !shop.cartOpeners.includes(target.trim())) {
        return { deny: `QA may only click the basket icon: ${shop.cartOpeners.map((s) => JSON.stringify(s)).join(' or ')}.` };
      }
    }
    return shopGuard(toolName, input);
  };
}
