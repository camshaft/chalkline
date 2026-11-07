// Bundles chalkline-lan for Node into dist/chalkline-lan.mjs. The Trystero
// packages stay outside the bundle and load from node_modules, with the ws
// package that the relay server runs on.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

await build({
  absWorkingDir: fileURLToPath(new URL('..', import.meta.url)),
  entryPoints: ['src/bin.ts'],
  outfile: 'dist/chalkline-lan.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['@trystero-p2p/*'],
  logLevel: 'info',
});
