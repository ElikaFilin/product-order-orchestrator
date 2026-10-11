import { afterEach, describe, expect, it } from 'vitest';
import { env, resetEnvCache } from '../src/config/env.js';

describe('env', () => {
  afterEach(() => {
    delete process.env.TELEGRAM_ALLOWED_USER_ID;
    delete process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN;
    resetEnvCache();
  });

  it('parses the allowed Telegram user id as a number and rejects anything else', () => {
    process.env.TELEGRAM_ALLOWED_USER_ID = '111222333';
    resetEnvCache();
    expect(env().TELEGRAM_ALLOWED_USER_ID).toBe(111222333);
    process.env.TELEGRAM_ALLOWED_USER_ID = 'me';
    resetEnvCache();
    expect(() => env()).toThrow(/must be a number/);
  });

  it('treats blank values as unset', () => {
    process.env.TELEGRAM_ALLOWED_USER_ID = ' ';
    process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN = '  ';
    resetEnvCache();
    expect(env().TELEGRAM_ALLOWED_USER_ID).toBeUndefined();
    expect(env().PLAYWRIGHT_MCP_EXTENSION_TOKEN).toBeUndefined();
  });
});
