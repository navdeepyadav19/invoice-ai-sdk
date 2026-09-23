import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  // Node 20 (the lowest supported, see `engines`) and every current edge
  // runtime support ES2022.
  target: 'es2022',
  platform: 'neutral',
  // esbuild already drops unused code when it bundles. tsup's extra rollup
  // tree-shaking pass re-renders the CJS file and warns about "named and
  // default exports together". esbuild's own CJS output handles both:
  // `require(pkg).InvoiceAI` and `require(pkg).default` are the same class.
  treeshake: false,
  splitting: false,
  esbuildOptions(options) {
    // Maps point at line numbers without embedding every source file again
    // (sourcesContent made up most of the unpacked package).
    options.sourcesContent = false
  },
})
