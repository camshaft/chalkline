import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  define: {
    // Excalidraw reads this to tell React from Preact.
    'process.env.IS_PREACT': JSON.stringify('false'),
  },
});
