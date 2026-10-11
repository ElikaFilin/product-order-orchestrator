import { describe, expect, it } from 'vitest';
import { parseHelperCall } from '../src/core/browser/guard.js';
import { ExecuteResult, QaResult, type ExecuteRequest, type QaRequest } from '../src/core/contracts.js';
import { finalizeExecuteResult, PageOps, summarizeExecute } from '../src/core/execute/result.js';
import { checkOrderForm, describeOrderForm, uncheckedOrderForm } from '../src/core/order-form.js';
import { PageReads, QaObservation, summarizeQa, toQaResult } from '../src/core/qa/report.js';

const FILLET = 'Філе зі стегна індички, 1 кг';
const CART_URL = 'https://karashynyard.com.ua/#opencart';
const CHECKOUT = { name: 'Тарас Тестовий', phone: '+380671234567', delivery: 'Доставка Новою поштою', address: 'вул. Тестова 1, Київ' };
/** The form as the shop holds it after fillOrderForm: the phone mask formats the number. */
const FILLED = { found: true, name: 'Тарас Тестовий', phone: '+380 (67) 123-45-67', delivery: 'Доставка Новою поштою', address: 'вул. Тестова 1, Київ' };

describe('checkOrderForm', () => {
  it('accepts the formatted phone and whitespace differences', () => {
    const check = checkOrderForm(CHECKOUT, { ...FILLED, address: ' вул. Тестова  1, Київ\n' });
    expect(check.status).toBe('ok');
    expect(check.fields.map((f) => [f.field, f.ok])).toEqual([
      ['name', true],
      ['phone', true],
      ['delivery', true],
      ['address', true],
    ]);
  });

  it('lists every field that differs, with the page detail', () => {
    const check = checkOrderForm(CHECKOUT, { ...FILLED, phone: '+48 50 123 45 67', delivery: null, detail: 'the phone field has country code +48' });
    expect(check).toMatchObject({ status: 'mismatch', detail: 'the phone field has country code +48' });
    expect(check.fields.filter((f) => !f.ok)).toEqual([
      { field: 'phone', expected: '+380671234567', actual: '+48 50 123 45 67', ok: false },
      { field: 'delivery', expected: 'Доставка Новою поштою', actual: '', ok: false },
    ]);
    expect(describeOrderForm(check)).toBe(
      'Order form differs: phone: expected "+380671234567", the form has "+48 50 123 45 67"; delivery: expected "Доставка Новою поштою", the form has "". (the phone field has country code +48)',
    );
  });

  it('is unverified when the page has no form', () => {
    expect(checkOrderForm(CHECKOUT, { found: false, name: '', phone: '', delivery: null, address: '' })).toEqual(
      uncheckedOrderForm('The order form was not found on the page.'),
    );
  });
});

describe('Execute: the order form from the page', () => {
  const request: ExecuteRequest = { type: 'execute-request', shopId: 'karashynyard', mode: 'initial', ops: [{ name: FILLET, targetQty: 2 }] };
  const reported = ExecuteResult.parse({ type: 'execute-result', shopId: 'x', cartUrl: 'x', ops: [{ name: FILLET, targetQty: 2, status: 'ok', actualQty: 2 }] });
  function pageOf(calls: Array<[string, unknown]>): PageOps {
    const page = new PageOps();
    for (const [code, value] of calls) page.record(parseHelperCall(code)!, value);
    return page;
  }
  const setQty = [`window.__poo.setQty(${JSON.stringify(FILLET)}, 2)`, { status: 'ok', name: FILLET, before: 0, after: 2 }] as [string, unknown];

  it('checks the last read-back after the basket changes, whatever the model reports', () => {
    const page = pageOf([setQty, ['window.__poo.fillOrderForm()', { ...FILLED, name: '' }], ['window.__poo.readOrderForm()', FILLED]]);
    const result = finalizeExecuteResult(request, reported, CART_URL, page, CHECKOUT);
    expect(result.orderForm?.status).toBe('ok');
    expect(ExecuteResult.parse(result)).toEqual(result);
    expect(summarizeExecute('initial', result)).toContain("Order form: filled in Execute's tab and checked (name, phone, delivery, address).");
  });

  it('is unverified when the form was never filled, or the basket changed after the last read', () => {
    expect(finalizeExecuteResult(request, reported, CART_URL, pageOf([setQty]), CHECKOUT).orderForm).toEqual(uncheckedOrderForm('The order form was not filled.'));
    const stale = pageOf([['window.__poo.fillOrderForm()', FILLED], setQty]);
    expect(finalizeExecuteResult(request, reported, CART_URL, stale, CHECKOUT).orderForm).toEqual(
      uncheckedOrderForm('The basket changed after the order form was last read.'),
    );
    expect(finalizeExecuteResult(request, reported, CART_URL, undefined, CHECKOUT).orderForm?.status).toBe('unverified');
  });

  it('ignores page results that do not look like the helper, and leaves the form out when nothing is configured', () => {
    const page = pageOf([setQty, ['window.__poo.readOrderForm()', 'Error: not on the shop']]);
    expect(finalizeExecuteResult(request, reported, CART_URL, page, CHECKOUT).orderForm?.status).toBe('unverified');
    expect(finalizeExecuteResult(request, reported, CART_URL, page)).not.toHaveProperty('orderForm');
  });
});

describe('QA: the order form check rides along', () => {
  const request = (orderForm?: QaRequest['orderForm']): QaRequest => ({
    type: 'qa-request',
    shopId: 'karashynyard',
    expected: [{ name: FILLET, qty: 2 }],
    focus: [],
    ...(orderForm ? { orderForm } : {}),
  });
  const observation = QaObservation.parse({ modalOpened: true, readVia: 'both', lines: [{ name: FILLET, qty: 2 }], total: 1330 });
  const page = new PageReads();
  page.record('readModal', { open: true, lines: [{ name: FILLET, qty: 2, amount: 1330 }], total: 1330 });

  it('matches only when the basket and the form are right', () => {
    const ok = toQaResult(request(checkOrderForm(CHECKOUT, FILLED)), observation, CART_URL, page);
    expect(ok).toMatchObject({ verdict: 'match', orderForm: { status: 'ok' } });
    expect(QaResult.parse(ok)).toEqual(ok);
    expect(summarizeQa(ok)).toBe("Basket matches (1 line).\nOrder form: filled in Execute's tab and checked (name, phone, delivery, address).");

    const wrong = toQaResult(request(checkOrderForm(CHECKOUT, { ...FILLED, address: '' })), observation, CART_URL, page);
    expect(wrong).toMatchObject({ verdict: 'mismatch', differences: [] });
    expect(summarizeQa(wrong)).toBe(
      'Basket matches (1 line).\nOrder form differs: address: expected "вул. Тестова 1, Київ", the form has "".',
    );
  });

  it('is the basket check alone when no form was filled', () => {
    const result = toQaResult(request(), observation, CART_URL, page);
    expect(result.verdict).toBe('match');
    expect(result).not.toHaveProperty('orderForm');
  });
});
