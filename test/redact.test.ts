import { describe, expect, it } from 'vitest';
import { createTabRedactor, hideForeignTabs } from '../src/core/browser/redact.js';

const SHOP = ['https://karashynyard.com.ua'];
const RESPONSE = [
  '### Result',
  '- 0: [Inbox (3) - me@example.com](https://mail.example.com/mail/u/0/#inbox)',
  "- 1: (current) [Карашинське подвір'я](https://karashynyard.com.ua/)",
  '- 2: [](about:blank)',
  '### Open tabs',
  '- 0: [Reset your password](https://bank.example.com/reset?token=abc)',
  "- 1: (current) [Карашинське подвір'я](https://karashynyard.com.ua/#opencart)",
  '- 2: weird line without a link',
  '### Page',
  '- Page URL: https://karashynyard.com.ua/',
  "- Page Title: Карашинське подвір'я",
].join('\n');

describe('hideForeignTabs', () => {
  it("hides the title and URL of every tab that is not on the shop, keeping the list's shape", () => {
    expect(hideForeignTabs(RESPONSE, SHOP)).toBe(
      [
        '### Result',
        '- 0: [another tab, hidden]',
        "- 1: (current) [Карашинське подвір'я](https://karashynyard.com.ua/)",
        '- 2: [](about:blank)',
        '### Open tabs',
        '- 0: [another tab, hidden]',
        "- 1: (current) [Карашинське подвір'я](https://karashynyard.com.ua/#opencart)",
        '- [another tab, hidden]',
        '### Page',
        '- Page URL: https://karashynyard.com.ua/',
        "- Page Title: Карашинське подвір'я",
      ].join('\n'),
    );
  });

  it('hides the current page when it is not the shop', () => {
    const page = '### Page\n- Page URL: https://mail.example.com/\n- Page Title: Inbox\n### Snapshot\n- [Snapshot](x.yml)';
    expect(hideForeignTabs(page, SHOP)).toBe('### Page\n- Page URL: [another tab, hidden]\n- Page Title: [another tab, hidden]\n### Snapshot\n- [Snapshot](x.yml)');
  });
});

describe('createTabRedactor', () => {
  const redact = createTabRedactor({ allowedOrigins: SHOP }, { prefix: 'playwright__' });

  it('rewrites only Playwright responses that list foreign tabs', () => {
    const out = redact('playwright__browser_tabs', [{ type: 'text', text: RESPONSE }]) as Array<{ text: string }>;
    expect(out[0]?.text).not.toMatch(/mail\.example|bank\.example|token=abc|Inbox/);
    expect(redact('playwright__browser_evaluate', [{ type: 'text', text: '### Result\n{"ready": true}' }])).toBeUndefined();
    expect(redact('poo_ask_user', [{ type: 'text', text: RESPONSE }])).toBeUndefined();
    expect(redact('playwright__browser_tabs', 'not content blocks')).toBeUndefined();
  });
});
