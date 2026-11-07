import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    server: {
      deps: {
        // Excalidraw imports roughjs, whose ES modules import their own files without a file
        // extension, which Node doesn't resolve. Vitest loads Excalidraw through Vite instead,
        // which resolves those imports as a bundler does.
        inline: [/@excalidraw\//],
      },
    },
    // A test file's first conversion loads jsdom and the whole of Excalidraw.
    testTimeout: 60_000,
  },
});
