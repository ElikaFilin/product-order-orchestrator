import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ROOT_DIR } from '../src/config/env.js';
import { ProductList, skillFile } from '../src/core/explore/product-list.js';

const SHOP = 'karashynyard';
const KYIV_CUTLETS = 'Котлети по-київськи з індички, 900 г';

/** Everything outside the frontmatter metadata and the product table must survive an update byte for byte. */
function stripVolatile(text: string): string {
  return text
    .replace(/^ {2}(version|updated):.*$/gm, '')
    .replace(/<!-- products:karashynyard:start -->[\s\S]*<!-- products:karashynyard:end -->/, '');
}

describe('Explore product list (ask-what-to-buy skill)', () => {
  let dir: string;
  let file: string;
  let list: ProductList;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'explore-skill-'));
    file = path.join(dir, 'SKILL.md');
    await copyFile(skillFile(ROOT_DIR), file);
    list = new ProductList(file);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('parses the initial list: 21 products with exact site names, SKUs and prices', async () => {
    const products = await list.read(SHOP);
    expect(products).toHaveLength(21);
    expect(products[0]).toEqual({ name: 'Філе зі стегна індички, 1 кг', sku: '1', priceUah: 665 });
    expect(products.at(-1)).toEqual({ name: 'Горіхова паста з фунндуком 350 г', sku: '513', priceUah: 850 });
    const names = products.map((p) => p.name);
    expect(new Set(names).size).toBe(21);
    expect(names.filter((n) => n === 'Котлети з фермерської індички та кролика, 900 г')).toHaveLength(1);
    expect(names).not.toContain(KYIV_CUTLETS);
  });

  it('adds a product with renumbering, bumps metadata and leaves the rest of the file untouched', async () => {
    const before = await readFile(file, 'utf8');

    const change = await list.update(SHOP, { add: [`  ${KYIV_CUTLETS} `], remove: [] });

    expect(change).toMatchObject({ added: [KYIV_CUTLETS], removed: [], alreadyListed: [], notFound: [] });
    expect(change.products).toHaveLength(22);
    const after = await readFile(file, 'utf8');
    expect(after).toContain(`| 22 | ${KYIV_CUTLETS} |  |  |`);
    expect(after).toContain('| 21 | Горіхова паста з фунндуком 350 г | 513 | 850 |');
    expect(after).toMatch(/^ {2}version: "2"$/m);
    expect(after).toMatch(new RegExp(`^ {2}updated: "${new Date().toISOString().slice(0, 10)}"$`, 'm'));
    expect(stripVolatile(after)).toBe(stripVolatile(before));
    expect((await list.read(SHOP)).at(-1)).toEqual({ name: KYIV_CUTLETS });
  });

  it('treats a duplicate add (any case or spacing) as a no-op and does not rewrite the file', async () => {
    await list.update(SHOP, { add: [KYIV_CUTLETS], remove: [] });
    const once = await readFile(file, 'utf8');

    const change = await list.update(SHOP, { add: ['котлети  по-київськи з індички, 900 г'], remove: [] });

    expect(change).toMatchObject({ added: [], alreadyListed: ['котлети по-київськи з індички, 900 г'] });
    expect(change.products).toHaveLength(22);
    expect(await readFile(file, 'utf8')).toBe(once);
  });

  it('removes a product, renumbers the rest and reports names that were not listed', async () => {
    const change = await list.update(SHOP, { add: [], remove: ['шиї курки, 1 кг', 'Неіснуючий товар'] });

    expect(change).toMatchObject({ added: [], removed: ['Шиї курки, 1 кг'], notFound: ['Неіснуючий товар'] });
    const products = await list.read(SHOP);
    expect(products).toHaveLength(20);
    expect(products.map((p) => p.name)).not.toContain('Шиї курки, 1 кг');
    const after = await readFile(file, 'utf8');
    expect(after).toContain('| 8 | Фарш з філе стегна курки, 1 кг | 514 | 625 |');
    expect(after).toContain('| 20 | Горіхова паста з фунндуком 350 г | 513 | 850 |');
  });

  it('serializes concurrent updates', async () => {
    await Promise.all([
      list.update(SHOP, { add: ['Товар А'], remove: [] }),
      list.update(SHOP, { add: ['Товар Б'], remove: [] }),
      list.update(SHOP, { add: [], remove: ['Стегно індички, 1 кг'] }),
    ]);
    const names = (await list.read(SHOP)).map((p) => p.name);
    expect(names).toHaveLength(22);
    expect(names.slice(-2)).toEqual(['Товар А', 'Товар Б']);
    expect(await readFile(file, 'utf8')).toMatch(/^ {2}version: "4"$/m);
  });

  it('rejects names that would break the table and shops without a list', async () => {
    await expect(list.update(SHOP, { add: ['bad | name'], remove: [] })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    // Claude Code would run !`...` from the skill as a shell command (and refuse to load the skill).
    await expect(list.update(SHOP, { add: ['Мед !`липовий`'], remove: [] })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(await list.read(SHOP)).toHaveLength(21);
    await expect(list.read('unknown-shop')).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(await list.read(SHOP)).toHaveLength(21);
  });
});
