import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    // Unit tests run against the SDK source, so they don't need an SDK build.
    alias: { '@horizonpay/invoice-ai': fileURLToPath(new URL('../sdk-ts/src/index.ts', import.meta.url)) },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    exclude: ['test/e2e/**'],
  },
})
