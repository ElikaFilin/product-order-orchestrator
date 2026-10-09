import { describe, expect, it } from 'vitest';
import { toolResultValue } from '../src/browser/mcp.js';

const cart = { lines: [{ name: 'Філе зі стегна індички, 1 кг', qty: 2 }], total: 1330, units: 2 };
// agent-browser 0.38.2 answers every call with this envelope; the page value is response.data.result.
const envelope = {
  exitCode: 0,
  response: { data: { lifecycle: { reused: true }, origin: 'https://karashynyard.com.ua/', result: cart }, error: null, success: true },
  stderr: '',
  stdout: '{"success":true}',
};

describe('toolResultValue', () => {
  it('Playwright: reads the "### Result" section of the content blocks', () => {
    const blocks = [{ type: 'text', text: `### Result\n${JSON.stringify(cart, null, 2)}\n### Ran Playwright code\n...` }];
    expect(toolResultValue('playwright', blocks)).toEqual(cart);
    expect(toolResultValue('playwright', { content: blocks })).toEqual(cart);
  });

  it('agent-browser: accepts the envelope as a string (the PostToolUse tool_response shape)', () => {
    expect(toolResultValue('agent-browser', JSON.stringify(envelope))).toEqual(cart);
  });

  it('agent-browser: accepts the envelope as an object, as text blocks, and as structuredContent', () => {
    expect(toolResultValue('agent-browser', envelope)).toEqual(cart);
    expect(toolResultValue('agent-browser', [{ type: 'text', text: JSON.stringify(envelope) }])).toEqual(cart);
    expect(toolResultValue('agent-browser', { content: [], structuredContent: envelope })).toEqual(cart);
  });

  it('falls back to the parsed text when there is no envelope', () => {
    expect(toolResultValue('agent-browser', '{"a":1}')).toEqual({ a: 1 });
    expect(toolResultValue('agent-browser', 'plain text')).toBe('plain text');
    expect(toolResultValue('agent-browser', undefined)).toBe('');
  });
});
