import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/contract/**/*.test.ts'],
    // Prism is downloaded and booted on first run.
    hookTimeout: 180_000,
    testTimeout: 30_000,
  },
})
