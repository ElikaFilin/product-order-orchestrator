/**
 * Deterministic editor of the per-shop product tables inside the ask-what-to-buy skill.
 * The model never edits SKILL.md itself: update_product_list lands here, so the table stays valid
 * and the next select-products question shows the change.
 */
import { randomUUID } from 'node:crypto';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { agentHome } from '../../config/agents.js';
import { normalizeName } from '../../shared/contracts.js';
import { AgentTaskError } from '../../shared/task-executor.js';

export const SKILL_NAME = 'ask-what-to-buy';

export function defaultSkillFile(): string {
  return path.join(agentHome('explore'), '.claude', 'skills', SKILL_NAME, 'SKILL.md');
}

export interface Product {
  name: string;
  sku?: string;
  priceUah?: number;
}

export interface ProductListChange {
  added: string[];
  removed: string[];
  /** Names asked to be added that were already listed. */
  alreadyListed: string[];
  /** Names asked to be removed that were not listed. */
  notFound: string[];
  /** The shop's list after the change. */
  products: Product[];
}

const TABLE_HEADER = ['| # | Товар | SKU | Ціна, грн |', '|---:|---|---|---:|'];
const MAX_NAME_LENGTH = 200;

/** Writers queue per file, so concurrent tasks in this process never interleave read-modify-write. */
const locks = new Map<string, Promise<unknown>>();

export class ProductList {
  readonly file: string;

  constructor(file: string = defaultSkillFile()) {
    this.file = path.resolve(file);
  }

  async read(shopId: string): Promise<Product[]> {
    return parseProducts(await readFile(this.file, 'utf8'), shopId);
  }

  /** Remove, then add (duplicates by normalizeName are skipped), renumber, save atomically. */
  async update(shopId: string, changes: { add: readonly string[]; remove: readonly string[] }): Promise<ProductListChange> {
    const add = changes.add.map(cleanName);
    return withLock(this.file, async () => {
      const text = await readFile(this.file, 'utf8');
      const change = applyChanges(parseProducts(text, shopId), add, changes.remove);
      if (change.added.length > 0 || change.removed.length > 0) {
        await writeAtomic(this.file, bumpMetadata(replaceSection(text, shopId, renderTable(change.products))));
      }
      return change;
    });
  }
}

function applyChanges(current: Product[], add: string[], remove: readonly string[]): ProductListChange {
  const removeKeys = new Set(remove.map(normalizeName));
  const products = current.filter((p) => !removeKeys.has(normalizeName(p.name)));
  const removed = current.filter((p) => removeKeys.has(normalizeName(p.name))).map((p) => p.name);
  const removedKeys = new Set(removed.map(normalizeName));
  const notFound = remove.filter((name) => !removedKeys.has(normalizeName(name)));

  const listed = new Set(products.map((p) => normalizeName(p.name)));
  const added: string[] = [];
  const alreadyListed: string[] = [];
  for (const name of add) {
    const key = normalizeName(name);
    if (listed.has(key)) {
      alreadyListed.push(name);
      continue;
    }
    listed.add(key);
    added.push(name);
    products.push({ name });
  }
  return { added, removed, alreadyListed, notFound, products };
}

/**
 * Names land in a markdown table cell between HTML-comment markers, so a few characters are off limits.
 * A backtick could also form Claude Code's inline-shell syntax (!`cmd`) in the skill, which breaks loading it.
 */
function cleanName(raw: string): string {
  const name = raw.replace(/\s+/g, ' ').trim();
  if (!name || name.length > MAX_NAME_LENGTH || /[|<>`]/.test(name)) {
    throw new AgentTaskError(
      'INVALID_REQUEST',
      `Invalid product name "${raw.slice(0, MAX_NAME_LENGTH)}": it must be 1-${MAX_NAME_LENGTH} characters without | < > \`.`,
    );
  }
  return name;
}

// ---------- markdown ----------

function sectionBounds(text: string, shopId: string): { from: number; to: number } {
  const start = `<!-- products:${shopId}:start -->`;
  const end = `<!-- products:${shopId}:end -->`;
  const startAt = text.indexOf(start);
  const to = startAt < 0 ? -1 : text.indexOf(end, startAt);
  if (to < 0) throw new AgentTaskError('INVALID_REQUEST', `There is no product list for shop "${shopId}".`);
  return { from: startAt + start.length, to };
}

function parseProducts(text: string, shopId: string): Product[] {
  const { from, to } = sectionBounds(text, shopId);
  return text
    .slice(from, to)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('|'))
    .map((line) => line.replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim()))
    .filter((cells) => cells[0] !== '#' && !cells.every((cell) => /^:?-+:?$/.test(cell)))
    .flatMap(([, name, sku, price]) => {
      if (!name) return [];
      const priceUah = price && /^\d+(\.\d+)?$/.test(price) ? Number(price) : undefined;
      return [{ name, ...(sku ? { sku } : {}), ...(priceUah !== undefined ? { priceUah } : {}) }];
    });
}

function renderTable(products: Product[]): string {
  const rows = products.map((p, i) => `| ${i + 1} | ${p.name} | ${p.sku ?? ''} | ${p.priceUah ?? ''} |`);
  return [...TABLE_HEADER, ...rows].join('\n');
}

function replaceSection(text: string, shopId: string, table: string): string {
  const { from, to } = sectionBounds(text, shopId);
  return `${text.slice(0, from)}\n${table}\n${text.slice(to)}`;
}

/** Bump metadata.version (last number + 1) and metadata.updated in the YAML frontmatter. */
function bumpMetadata(text: string): string {
  const end = text.startsWith('---\n') ? text.indexOf('\n---', 4) : -1;
  if (end < 0) return text;
  const today = new Date().toISOString().slice(0, 10);
  const frontmatter = text
    .slice(0, end)
    .replace(/^([ \t]+version:[ \t]*)"?(.*?)"?[ \t]*$/m, (_m, key: string, version: string) => {
      return `${key}"${version.replace(/\d+$/, (n) => String(Number(n) + 1))}"`;
    })
    .replace(/^([ \t]+updated:[ \t]*).*$/m, (_m, key: string) => `${key}"${today}"`);
  return frontmatter + text.slice(end);
}

async function writeAtomic(file: string, content: string): Promise<void> {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, content, 'utf8');
    await rename(tmp, file);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const run = (locks.get(key) ?? Promise.resolve()).then(fn);
  locks.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}
