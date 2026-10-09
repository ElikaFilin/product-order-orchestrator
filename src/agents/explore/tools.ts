import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { ShopId } from '../../shared/contracts.js';
import { errorMessage } from '../../shared/logger.js';
import type { ProductList, ProductListChange } from './product-list.js';

/**
 * `update_product_list`: the model's only way to change a product list. Every applied change is
 * pushed to `applied`, so the task result reports what really happened, not what the model says.
 */
export function updateProductListTool(shopId: string, productList: ProductList, applied: ProductListChange[]) {
  return tool(
    'update_product_list',
    'Add products to and/or remove products from the shop product list in the ask-what-to-buy skill. Names to add ' +
      'are saved exactly as given; duplicates and removals are matched ignoring case and extra spaces. Returns what changed.',
    {
      shopId: ShopId.describe('Shop id of the list, e.g. karashynyard'),
      add: z.array(z.string().min(1)).default([]).describe('Exact product names to add'),
      remove: z.array(z.string().min(1)).default([]).describe('Exact product names to remove'),
    },
    async (args) => {
      if (args.shopId !== shopId) {
        return { content: [{ type: 'text', text: `This task may only change the list of shop "${shopId}".` }], isError: true };
      }
      try {
        const change = await productList.update(shopId, args);
        applied.push(change);
        const { added, removed, alreadyListed, notFound } = change;
        const report = { added, removed, alreadyListed, notFound, productCount: change.products.length };
        return { content: [{ type: 'text', text: JSON.stringify(report) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `update_product_list failed: ${errorMessage(err)}` }], isError: true };
      }
    },
    { annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } },
  );
}
