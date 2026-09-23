import { defineConfig } from 'tsup'

/**
 * One ESM file with a shebang. Pure-JS dependencies (commander, clack,
 * cli-table3, picocolors) are bundled so `invoice-ai --help` doesn't walk
 * node_modules on every start; the heavier ones are `await import()`ed where
 * they're used, which esbuild keeps lazy inside the bundle.
 *
 * Left external and installed as real dependencies:
 * - @horizonpay/invoice-ai: the SDK. The CLI is its first customer, so SDK
 *   fixes reach the CLI through an ordinary dependency update.
 * - @napi-rs/keyring: a native addon with one binary per platform.
 * - open: ships an `xdg-open` script that it locates next to its own file.
 */
export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  platform: 'node',
  // Matches `engines.node` (>=20).
  target: 'node20',
  clean: true,
  sourcemap: false,
  splitting: false,
  treeshake: true,
  external: ['@horizonpay/invoice-ai', '@napi-rs/keyring', 'open'],
  // cli-table3 is CommonJS and require()s Node built-ins; give the ESM bundle
  // a real `require` so those calls work.
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);",
  },
})
