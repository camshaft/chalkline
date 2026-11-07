import { defineConfig } from 'vitest/config';

// The board-size measurement, which `npm run measure` runs once `npm run build` has built the page
// and chalkline-mcp. `npm test` and `npm run test:e2e` leave it out, since its files end in
// .measure.ts, which neither Vitest's own pattern nor vitest.e2e.config.ts matches.
export default defineConfig({
  test: {
    include: ['e2e/**/*.measure.ts'],
  },
});
