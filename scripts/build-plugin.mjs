// Bundle src/plugin into openclaw/plugin/dist/index.js: one self-contained ES module (zod, typebox and the domain
// code inlined; the OpenClaw SDK is used for types only), so the gateway loads it without the repo's node_modules.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
await build({
  absWorkingDir: root,
  entryPoints: ['src/plugin/index.ts'],
  outfile: 'openclaw/plugin/dist/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  external: ['openclaw', 'openclaw/*'],
  legalComments: 'none',
  logLevel: 'warning',
  banner: { js: "import { createRequire as __pooCreateRequire } from 'node:module'; const require = __pooCreateRequire(import.meta.url);" },
});
console.log('built openclaw/plugin/dist/index.js');
