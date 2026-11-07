import { defineConfig } from 'vitest/config';

// The end-to-end test, which `npm run test:e2e` runs once `npm run build` has built the page and
// chalkline-mcp. `npm test` leaves it out, since its files end in .e2e.ts, which Vitest's own
// pattern doesn't match.
export default defineConfig({
  test: {
    include: ['e2e/**/*.e2e.ts'],
  },
});
