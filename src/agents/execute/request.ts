import { ExecuteRequest, normalizeName, pickPayload, Selection, type BasketOp } from '../../shared/contracts.js';
import { AgentTaskError } from '../../shared/task-executor.js';
import type { ShopAdapter } from '../../shops/types.js';

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

export function buildExecutePrompt(
  request: ExecuteRequest,
  shop: Pick<ShopAdapter, 'id' | 'name' | 'baseUrl' | 'cartUrl'>,
  instruction: string,
): string {
  const describe = (op: BasketOp) => (op.targetQty === 0 ? 'remove from the basket' : `quantity ${op.targetQty}`);
  const cos = instruction.trim() ? ['', 'Instruction from the Chief of Staff:', instruction.trim()] : [];
  return [
    `Shop: ${shop.name} (${shop.baseUrl}).`,
    `Mode: ${MODE_TEXT[request.mode]}`,
    '',
    'Make the basket contain exactly these quantities (absolute targets; 0 removes the line):',
    ...request.ops.map((op, i) => `${i + 1}. ${op.name} — ${describe(op)}`),
    '',
    'Same operations as JSON:',
    JSON.stringify(request.ops),
    ...cos,
    '',
    `Return one entry in \`ops\` per operation above (same name and targetQty), the basket lines in \`cart\`, ` +
      `shopId "${shop.id}" and cartUrl "${shop.cartUrl}".`,
  ].join('\n');
}

/** Turn budget: tab, page ready (up to 2), two basket reads and the answer, plus a call and a retry per operation, with headroom. */
export function maxTurnsFor(request: ExecuteRequest): number {
  return 16 + 3 * request.ops.length;
}
