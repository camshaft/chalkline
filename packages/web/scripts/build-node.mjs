// Bundles draw-box for Node into dist-node/draw-box.mjs. werift and jsdom stay
// outside the bundle and load from node_modules, since they read files of their
// own at run time.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

await build({
  absWorkingDir: fileURLToPath(new URL('..', import.meta.url)),
  entryPoints: ['scripts/draw-box.ts'],
  outfile: 'dist-node/draw-box.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['werift', 'jsdom', 'global-jsdom'],
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
    'process.env.IS_PREACT': JSON.stringify('false'),
  },
  // The script doesn't render anything, so Excalidraw's styles, fonts and images load as nothing.
  loader: {
    '.css': 'empty',
    '.woff2': 'empty',
    '.woff': 'empty',
    '.ttf': 'empty',
    '.png': 'empty',
    '.svg': 'empty',
  },
  // Bundled CommonJS code calls `require`, which an ES module lacks.
  banner: {
    js: "import { createRequire as chalklineCreateRequire } from 'node:module'; const require = chalklineCreateRequire(import.meta.url);",
  },
  logLevel: 'info',
});
