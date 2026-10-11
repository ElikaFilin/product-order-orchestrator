import { describe, expect, it } from 'vitest';
import { toolResultValue } from '../src/core/browser/toolset.js';

const cart = { lines: [{ name: 'Філе зі стегна індички, 1 кг', qty: 2 }], total: 1330, units: 2 };

describe('toolResultValue', () => {
  it('reads the "### Result" section of the content blocks', () => {
    const blocks = [{ type: 'text', text: `### Result\n${JSON.stringify(cart, null, 2)}\n### Ran Playwright code\n...` }];
    expect(toolResultValue(blocks)).toEqual(cart);
    expect(toolResultValue({ content: blocks })).toEqual(cart);
  });

  it('falls back to the text when there is no result section', () => {
    expect(toolResultValue('### Page\n- Page URL: about:blank')).toBe('### Page\n- Page URL: about:blank');
    expect(toolResultValue('### Result\nnot json')).toBe('not json');
    expect(toolResultValue(undefined)).toBe('');
  });
});
