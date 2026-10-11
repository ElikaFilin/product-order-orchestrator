import { pickPayload, QaRequest, Selection, type QaFocus } from '../contracts.js';
import { AgentTaskError } from '../errors.js';
import type { ShopAdapter } from '../shops/types.js';

/** The QA request COS sent, or one built from a forwarded Selection (expected = what the user chose). */
export function resolveQaRequest(data: readonly unknown[]): QaRequest {
  const request = pickPayload(data, QaRequest);
  if (request) return request;
  const selection = pickPayload(data, Selection);
  if (selection) return { type: 'qa-request', shopId: selection.shopId, expected: selection.items, focus: [] };
  throw new AgentTaskError('INVALID_REQUEST', 'The message carries neither a qa-request nor a selection payload.');
}

function describeFocus(f: QaFocus): string {
  const name = JSON.stringify(f.name);
  switch (f.check) {
    case 'quantity':
      return f.expectedQty === undefined ? `${name}: quantity must match the order above` : `${name}: quantity must now be ${f.expectedQty}`;
    case 'present':
      return f.expectedQty === undefined ? `${name}: must be in the basket` : `${name}: must be in the basket with quantity ${f.expectedQty}`;
    case 'absent':
      return `${name}: must no longer be in the basket`;
  }
}

export function buildQaPrompt(
  request: QaRequest,
  shop: Pick<ShopAdapter, 'name' | 'baseUrl'>,
  instruction: string,
): string {
  const units = request.expected.reduce((sum, item) => sum + item.qty, 0);
  const expected = request.expected.length
    ? [
        `The user's order should contain ${request.expected.length} line(s), ${units} unit(s):`,
        ...request.expected.map((item, i) => `${i + 1}. ${item.name} — ${item.qty}`),
        '',
        'Same list as JSON:',
        JSON.stringify(request.expected.map(({ name, qty }) => ({ name, qty }))),
      ]
    : ['The user\'s order should be empty: the basket should have no lines.'];
  const focus = request.focus.length
    ? ['', 'Check these lines with extra care:', ...request.focus.map((f) => `- ${describeFocus(f)}`)]
    : [];
  const cos = instruction.trim() ? ['', 'Instruction from the Chief of Staff:', instruction.trim()] : [];

  return [
    `Shop: ${shop.name} (${shop.baseUrl}).`,
    'Open the basket in the user\'s browser and report exactly what it contains.',
    '',
    ...expected,
    ...focus,
    ...cos,
    '',
    'Report every line you see, including lines that are not in the list and lines with other quantities.',
    'Do not decide whether the basket is right: the system compares your observation with the order.',
    'Never change the basket.',
  ].join('\n');
}
