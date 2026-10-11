import { afterEach, describe, expect, it } from 'vitest';
import { checkoutDetails, env, resetEnvCache } from '../src/config/env.js';

describe('env', () => {
  afterEach(() => {
    delete process.env.TELEGRAM_ALLOWED_USER_ID;
    delete process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN;
    for (const key of ['CHECKOUT_NAME', 'CHECKOUT_PHONE', 'CHECKOUT_DELIVERY', 'CHECKOUT_ADDRESS']) delete process.env[key];
    resetEnvCache();
  });

  const setCheckout = (values: Record<string, string>) => {
    Object.assign(process.env, values);
    resetEnvCache();
  };

  it('reads the order form details: all four or none', () => {
    expect(checkoutDetails()).toBeUndefined();
    setCheckout({ CHECKOUT_NAME: 'Тарас Тестовий', CHECKOUT_PHONE: '+380 (67) 123-45-67' });
    expect(() => checkoutDetails()).toThrow(/Missing: CHECKOUT_DELIVERY, CHECKOUT_ADDRESS/);
    setCheckout({ CHECKOUT_DELIVERY: 'Доставка Новою поштою', CHECKOUT_ADDRESS: 'вул. Тестова 1, Київ' });
    expect(checkoutDetails()).toEqual({
      name: 'Тарас Тестовий',
      phone: '+380671234567',
      delivery: 'Доставка Новою поштою',
      address: 'вул. Тестова 1, Київ',
    });
  });

  it('wants the phone in international format', () => {
    setCheckout({ CHECKOUT_NAME: 'Е', CHECKOUT_PHONE: '671234567', CHECKOUT_DELIVERY: 'Д', CHECKOUT_ADDRESS: 'А' });
    expect(() => checkoutDetails()).toThrow(/international format/);
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
