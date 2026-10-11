/**
 * COS's memory: `MEMORY.md` in its OpenClaw workspace. COS writes there what the user asks it to remember
 * ("save this - ..."), such as the products that go into every new order. The file is the user's, so git ignores it.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { agentHome } from './agents.js';

export const MEMORY_FILE_NAME = 'MEMORY.md';

export function memoryFile(repoRoot: string): string {
  return path.join(agentHome(repoRoot, 'cos'), MEMORY_FILE_NAME);
}

/** The file a new installation starts with: the sections COS keeps, empty. */
export const MEMORY_TEMPLATE = `# Memory

What the user asked the Chief of Staff to remember with "save this". The Chief of Staff keeps this file up to date.

## Every order

Products added to every new order: one line each, "- <exact product name> × <quantity>". None yet.

## Notes

None yet.
`;

/** Create the memory file from the template when it does not exist yet; never overwrite it. */
export function ensureMemoryFile(file: string): void {
  if (existsSync(file)) return;
  mkdirSync(path.dirname(file), { recursive: true });
  try {
    writeFileSync(file, MEMORY_TEMPLATE, { flag: 'wx', mode: 0o600 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
}
