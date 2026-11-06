import { defineConfig } from 'vite';

// Relative asset paths let one build load from GitHub Pages' project path
// (/chalkline/) and from the root of a server on a local network.
export default defineConfig({
  base: './',
  define: {
    // Excalidraw reads this to tell React from Preact.
    'process.env.IS_PREACT': JSON.stringify('false'),
  },
  resolve: {
    // Each of Excalidraw's dependencies takes the board's one copy of React: hooks that run on a
    // second copy find its dispatcher null, as the first probe showed ("reading 'useEffect'").
    dedupe: ['react', 'react-dom'],
  },
});
