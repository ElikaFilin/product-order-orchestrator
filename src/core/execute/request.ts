import { ExecuteRequest, normalizeName, pickPayload, Selection, type BasketOp } from '../contracts.js';
import { AgentTaskError } from '../errors.js';
import type { ShopAdapter } from '../shops/types.js';

/**
 * The execute-request COS sent, or an initial request built from a forwarded Selection.
 * Selection lines with the same product are summed: ops set absolute quantities, so two ops for
 * one product would overwrite each other.
 */
export function resolveExecuteRequest(data: readonly unknown[]): ExecuteRequest {
  const request = pickPayload(data, ExecuteRequest);
  if (request) return request;
  const selection = pickPayload(data, Selection);
  if (!selection) {
    throw new AgentTaskError('INVALID_REQUEST', 'The message carries neither an execute-request nor a selection payload.');
  }
  const ops = new Map<string, BasketOp>();
  for (const item of selection.items) {
    const key = normalizeName(item.name);
    const op = ops.get(key);
    if (op) op.targetQty += item.qty;
    else ops.set(key, { name: item.name, targetQty: item.qty, ...(item.sku ? { sku: item.sku } : {}) });
  }
  return { type: 'execute-request', shopId: selection.shopId, mode: 'initial', ops: [...ops.values()] };
}

const MODE_TEXT: Record<ExecuteRequest['mode'], string> = {
  initial: 'initial: fill the basket for the whole order (lines that already have the right quantity stay as they are).',
  fix: 'fix: correct the basket after a QA check. Change only the lines listed below.',
};

export function buildExecutePrompt(request: ExecuteRequest, shop: Pick<ShopAdapter, 'name' | 'baseUrl'>, instruction: string): string {
  const describe = (op: BasketOp) => (op.targetQty === 0 ? 'remove from the basket' : `quantity ${op.targetQty}`);
  const cos = instruction.trim() ? ['', 'Instruction from the Chief of Staff:', instruction.trim()] : [];
  const clear = request.clearBasket
    ? [
        'New order: clear the basket first. If the basket you read before changing it has lines that are not listed ' +
          'below, remove each of them (target 0) before the operations: the basket keeps nothing from earlier orders.',
      ]
    : [];
  return [
    `Shop: ${shop.name} (${shop.baseUrl}).`,
    `Mode: ${MODE_TEXT[request.mode]}`,
    ...clear,
    '',
    'Make the basket contain exactly these quantities (absolute targets; 0 removes the line):',
    ...request.ops.map((op, i) => `${i + 1}. ${op.name} — ${describe(op)}`),
    '',
    'Same operations as JSON:',
    JSON.stringify(request.ops),
    ...cos,
    '',
    'When you are done, call poo_submit_execute with one entry in `ops` per operation above (same name and ' +
      'targetQty, with its status) and the basket lines from your last readCart() in `cart`.',
  ].join('\n');
}
