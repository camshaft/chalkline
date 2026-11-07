// Bundles chalkline-mcp for Node into dist/chalkline-mcp.mjs, as draw-box's build bundles
// draw-box. werift, jsdom and resvg stay outside the bundle and load from node_modules, since they
// read files of their own at run time, such as resvg's native module for the machine.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

await build({
  absWorkingDir: fileURLToPath(new URL('..', import.meta.url)),
  entryPoints: ['src/main.ts'],
  outfile: 'dist/chalkline-mcp.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['werift', 'jsdom', 'global-jsdom', '@resvg/resvg-js'],
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
    'process.env.IS_PREACT': JSON.stringify('false'),
  },
  // The helper draws its pictures from SVG with resvg, which draws text in the font that render.ts
  // loads from node_modules, so Excalidraw's styles, fonts and images load as nothing.
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
