#!/usr/bin/env node
/**
 * After `changeset version` bumps the npm packages, copy that version into the
 * places Changesets doesn't know about: the SDK's VERSION (sent in User-Agent),
 * the CLI's --version constant and the Python SDK. npm pre-releases (0.2.0-rc.1) become PEP 440 (0.2.0rc1).
 */
import { readFileSync, writeFileSync } from 'node:fs'

const version = JSON.parse(readFileSync('packages/sdk-ts/package.json', 'utf8')).version
const pep440 = version.replace(/-(a|alpha|b|beta|rc)\.?(\d+)$/, (_, tag, n) => `${{ alpha: 'a', a: 'a', beta: 'b', b: 'b', rc: 'rc' }[tag]}${n}`)

const edit = (file, pattern, replacement) => {
  const before = readFileSync(file, 'utf8')
  const after = before.replace(pattern, replacement)
  if (after === before && !before.includes(replacement)) throw new Error(`sync-versions: no version found in ${file}`)
  writeFileSync(file, after)
}

edit('packages/sdk-ts/src/core/version.ts', /VERSION = '[^']+'/, `VERSION = '${version}'`)
edit('packages/cli/src/constants.ts', /CLI_VERSION = '[^']+'/, `CLI_VERSION = '${version}'`)
edit('packages/sdk-python/invoice_ai/_version.py', /__version__ = "[^"]+"/, `__version__ = "${pep440}"`)
console.log(`Synced version ${version} (Python ${pep440}).`)
