import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  // Node 18 and every current edge runtime support ES2022.
  target: 'es2022',
  platform: 'neutral',
  treeshake: true,
  splitting: false,
})
