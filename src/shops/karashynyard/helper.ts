/**
 * In-page helper `window.__poo` for karashynyard.com.ua (Tilda T776 product cards + T706 cart).
 * The browser guard prepends HELPER_SOURCE to every eval call, so the playbooks can call
 * `window.__poo.setQty(...)` etc. without pasting code.
 *
 * Tilda facts this relies on (read in tilda-cart-1.1 and exercised live by `pnpm smoke:shop`):
 *  - grid cards are `.t776__col.js-product`; each also has a hidden popup copy `.t776__product-full`;
 *  - the card's add button reads the card's quantity input and MERGES by incrementing an existing line;
 *    the title/image links also add, so they are never clicked;
 *  - a repeat click on the same add button within 1 s is ignored (`data-dbclk-prevent`);
 *  - after an add the cart window opens (`data-opencart-onorder`), covering the page;
 *  - the cart window's minus/delete controls change the basket; delete keeps a 4 s undo row that only
 *    finishes while the window stays open;
 *  - the basket lives in localStorage `tcart`; deleted lines linger there with `deleted: "yes"`.
 *
 * Written as plain JavaScript inside a string (not a serialized TS function) because transpilers may
 * inject helpers that do not exist in the page. String.raw keeps the regex backslashes as written; the
 * body must not contain backticks or "${".
 */
import { createHash } from 'node:crypto';

const BODY = String.raw`
  var CARD = '.t776__col.js-product';
  var ROWS = '.t706__cartwin-products .t706__product';
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var waitFor = async function (fn, timeoutMs) {
    var end = Date.now() + timeoutMs;
    for (;;) {
      var v;
      try { v = fn(); } catch (e) { v = undefined; }
      if (v || Date.now() > end) return v;
      await sleep(100);
    }
  };
  // Typographic apostrophes (U+2019, U+02BC, grave, acute) all count as "'".
  var APOSTROPHES = new RegExp('[' + String.fromCharCode(0x2019, 0x2bc, 0x60, 0xb4) + ']', 'g');
  var norm = function (s) {
    return String(s == null ? '' : s).normalize('NFC').replace(APOSTROPHES, "'").replace(/\s+/g, ' ').trim().toLowerCase();
  };
  var num = function (s) {
    var m = String(s == null ? '' : s).replace(/\s/g, '').replace(',', '.').match(/\d+(\.\d+)?/);
    return m ? Number(m[0]) : null;
  };
  var text = function (el) { return el ? el.textContent.trim() : ''; };

  var cards = function () {
    return Array.from(document.querySelectorAll(CARD)).filter(function (c) { return !c.closest('.t776__product-full'); });
  };
  var cardName = function (c) { return text(c.querySelector('.js-product-name')); };
  var findCard = function (name) {
    var n = norm(name);
    return cards().find(function (c) { return norm(cardName(c)) === n; }) || null;
  };
  var bigrams = function (s) {
    var m = new Map();
    for (var i = 0; i < s.length - 1; i++) m.set(s.slice(i, i + 2), (m.get(s.slice(i, i + 2)) || 0) + 1);
    return m;
  };
  var similarity = function (a, b) {
    var A = bigrams(a), B = bigrams(b), common = 0;
    A.forEach(function (v, k) { common += Math.min(v, B.get(k) || 0); });
    var total = Math.max(a.length - 1, 0) + Math.max(b.length - 1, 0);
    return total ? (2 * common) / total : 0;
  };
  var candidates = function (name) {
    var n = norm(name);
    return Array.from(new Set(cards().map(cardName).filter(Boolean)))
      .map(function (x) { return [similarity(n, norm(x)), x]; })
      .sort(function (p, q) { return q[0] - p[0]; })
      .slice(0, 5).map(function (p) { return p[1]; });
  };

  var ready = function () {
    return document.readyState === 'complete' && window.tcart_initted === 'yes' && !!window.tcart && cards().length > 0;
  };
  var readCart = function () {
    var data = null;
    try { data = JSON.parse(localStorage.getItem('tcart') || 'null'); } catch (e) { data = null; }
    var products = data && Array.isArray(data.products) ? data.products : [];
    var lines = products
      .filter(function (p) { return p && p.name && p.deleted !== 'yes' && Number(p.quantity) > 0; })
      .map(function (p) {
        var qty = Number(p.quantity), unitPrice = Number(p.price);
        return { name: String(p.name), qty: qty, unitPrice: unitPrice,
          amount: p.amount == null ? unitPrice * qty : Number(p.amount), sku: p.sku == null ? '' : String(p.sku) };
      });
    return {
      lines: lines,
      units: lines.reduce(function (s, l) { return s + l.qty; }, 0),
      total: lines.reduce(function (s, l) { return s + l.amount; }, 0),
    };
  };
  var lineQty = function (name) {
    var n = norm(name);
    return readCart().lines.filter(function (l) { return norm(l.name) === n; }).reduce(function (s, l) { return s + l.qty; }, 0);
  };

  var isOpen = function () {
    var w = document.querySelector('.t706__cartwin');
    return !!w && w.classList.contains('t706__cartwin_showed');
  };
  var rows = function () { return Array.from(document.querySelectorAll(ROWS)); };
  var rowName = function (r) {
    var a = r.querySelector('.t706__product-title a');
    if (a) return text(a);
    var t = r.querySelector('.t706__product-title');
    return t && t.firstChild ? t.firstChild.textContent.trim() : '';
  };
  var rowQty = function (r) {
    var q = r.querySelector('.t706__product-quantity');
    if (!q) return 0;
    var input = q.querySelector('input');
    return num(input ? input.value : q.textContent) || 0;
  };
  var readModal = function () {
    return {
      open: isOpen(),
      lines: rows().map(function (r) {
        return { name: rowName(r), qty: rowQty(r), amount: num(text(r.querySelector('.t706__product-amount'))) };
      }),
      total: num(text(document.querySelector('.t706__cartwin-prodamount'))),
    };
  };
  var openCart = async function () {
    if (!isOpen()) {
      var icon = document.querySelector('.t706__carticon');
      if (icon) icon.click();
      if (!(await waitFor(isOpen, 1500)) && typeof window.tcart__openCart === 'function') window.tcart__openCart();
    }
    return { open: !!(await waitFor(isOpen, 5000)) };
  };
  var closeCart = async function () {
    if (isOpen()) {
      var btn = document.querySelector('.t706__cartwin .t706__close-button');
      if (btn) btn.click();
      if (!(await waitFor(function () { return !isOpen(); }, 1500)) && typeof window.tcart__closeCart === 'function') {
        window.tcart__closeCart();
      }
    }
    return { closed: !!(await waitFor(function () { return !isOpen(); }, 3000)) };
  };

  var increase = async function (card, n) {
    await closeCart();
    var name = cardName(card), before = lineQty(name);
    var input = card.querySelector('input.t-store__prod__quantity-input');
    var btn = card.querySelector('a.t776__btn[href="#order"]:not(.t776__btn_second)');
    if (!btn) throw new Error('add button not found on the product card');
    if (!input && n !== 1) throw new Error('quantity input not found on the product card');
    await waitFor(function () { return !btn.hasAttribute('data-dbclk-prevent'); }, 2000);
    if (input) {
      input.value = String(n);
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    btn.click();
    if (!(await waitFor(function () { return lineQty(name) > before; }, 5000))) throw new Error('Tilda did not add the product');
    await waitFor(isOpen, 2000);
    await closeCart();
  };
  var decrease = async function (name, target) {
    if (!(await openCart()).open) throw new Error('the cart window did not open');
    var n = norm(name);
    for (var step = 0; step < 1000; step++) {
      var current = lineQty(name);
      if (current <= target) break;
      var row = rows().filter(function (r) { return norm(rowName(r)) === n; }).pop();
      if (!row) throw new Error('the product is in localStorage but not in the cart window');
      var control = rowQty(row) - (current - target) >= 1 ? '.t706__product-minus' : '.t706__product-del';
      row.querySelector(control).click();
      if (!(await waitFor(function () { return lineQty(name) < current; }, 3000))) throw new Error('Tilda ignored ' + control);
    }
    await waitFor(function () { return !document.querySelector('.t706__product-deleted'); }, 7000);
    await closeCart();
  };

  var setQty = async function (name, qty) {
    var target = Number(qty);
    var label = String(name);
    if (!Number.isInteger(target) || target < 0 || target > 999) {
      return { status: 'failed', name: label, before: lineQty(label), after: lineQty(label), detail: 'qty must be an integer 0..999' };
    }
    if (!(await waitFor(ready, 15000))) {
      return { status: 'failed', name: label, before: lineQty(label), after: lineQty(label), detail: 'the shop page is not ready' };
    }
    var card = findCard(label);
    if (card) label = cardName(card);
    var before = lineQty(label);
    var detail;
    try {
      for (var attempt = 0; attempt < 3 && lineQty(label) !== target; attempt++) {
        if (target > lineQty(label)) {
          if (!card) {
            return { status: 'not_found', name: label, before: before, after: before,
              detail: 'no product card with this exact name; closest: ' + candidates(label).join(' | ') };
          }
          await increase(card, target - lineQty(label));
        } else {
          await decrease(label, target);
        }
      }
    } catch (e) {
      detail = e && e.message ? e.message : String(e);
    }
    var after = lineQty(label);
    var result = { status: after === target ? 'ok' : 'failed', name: label, before: before, after: after };
    if (detail) result.detail = detail;
    return result;
  };

  return {
    // Waits for the page itself (default 10 s), so an agent needs one call instead of a polling loop of tool turns.
    status: async function (waitMs) {
      await waitFor(ready, waitMs === undefined ? 10000 : Number(waitMs));
      var c = readCart();
      return { ready: !!ready(), url: location.href, cartLines: c.lines.length, units: c.units, total: c.total };
    },
    find: function (name) {
      var c = findCard(name);
      if (!c) return { found: false, candidates: candidates(name) };
      var rec = c.closest('[id^="rec"]');
      return {
        found: true,
        name: cardName(c),
        price: num(text(c.querySelector('.js-product-price'))),
        sku: text(c.querySelector('.js-product-sku')),
        selector: (rec ? '#' + rec.id + ' ' : '') + CARD + '[data-product-lid="' + c.getAttribute('data-product-lid') + '"]',
      };
    },
    readCart: readCart,
    readModal: readModal,
    openCart: openCart,
    closeCart: closeCart,
    setQty: setQty,
  };
`;

export const HELPER_VERSION = createHash('sha256').update(BODY).digest('hex').slice(0, 12);

/** Statements that (re)define window.__poo unless the same version is already installed. */
export const HELPER_SOURCE =
  `if (!window.__poo || window.__poo.version !== '${HELPER_VERSION}') {` +
  ` window.__poo = Object.assign((function () {${BODY}})(), { version: '${HELPER_VERSION}' }); }`;
