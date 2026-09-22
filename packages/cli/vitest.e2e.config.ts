import { defineConfig } from 'vitest/config'

/**
 * Runs the BUILT binary (dist/index.js) against a Prism mock of the API.
 * Build first: `pnpm --filter @horizonpay/invoice-ai build && pnpm --filter @horizonpay/invoice-ai-cli build`.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/e2e/**/*.test.ts'],
    // Prism is downloaded and booted on first run.
    hookTimeout: 180_000,
    testTimeout: 30_000,
  },
})
