#!/usr/bin/env node
/**
 * The TS SDK, the CLI and the Python SDK are released together at one version.
 * Fail if any of the places that spell that version disagree:
 *
 *   packages/sdk-ts/package.json                "version"
 *   packages/sdk-ts/src/core/version.ts         VERSION  (sent in the User-Agent)
 *   packages/cli/package.json                   "version"
 *   packages/cli/src/constants.ts               CLI_VERSION  (`invoice-ai --version`)
 *   packages/sdk-python/invoice_ai/_version.py  __version__
 *   packages/sdk-python/pyproject.toml          [project] version, unless it is
 *                                               dynamic, in which case it must be
 *                                               read from invoice_ai/_version.py
 *
 *   node scripts/ci/check-versions.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')
const problems = []

function match(rel, re, what) {
  const m = read(rel).match(re)
  if (!m) {
    problems.push(`${rel}: could not find ${what}`)
    return undefined
  }
  return m[1]
}

const found = [
  ['packages/sdk-ts/package.json', JSON.parse(read('packages/sdk-ts/package.json')).version],
  ['packages/sdk-ts/src/core/version.ts', match('packages/sdk-ts/src/core/version.ts', /export const VERSION = ['"]([^'"]+)['"]/, 'VERSION')],
  ['packages/cli/package.json', JSON.parse(read('packages/cli/package.json')).version],
  ['packages/cli/src/constants.ts', match('packages/cli/src/constants.ts', /export const CLI_VERSION = ['"]([^'"]+)['"]/, 'CLI_VERSION')],
  [
    'packages/sdk-python/invoice_ai/_version.py',
    match('packages/sdk-python/invoice_ai/_version.py', /^__version__\s*=\s*['"]([^'"]+)['"]/m, '__version__'),
  ],
]

// pyproject.toml: a static `version = "…"` under [project] must match too; a
// dynamic one must be sourced from _version.py (hatch), or it could drift.
const pyproject = read('packages/sdk-python/pyproject.toml')
const projectTable = pyproject.match(/^\[project\]\s*$([\s\S]*?)(?=^\[)/m)?.[1] ?? ''
const staticVersion = projectTable.match(/^version\s*=\s*['"]([^'"]+)['"]/m)?.[1]
const isDynamic = /^dynamic\s*=\s*\[[^\]]*['"]version['"]/m.test(projectTable)
if (staticVersion) {
  found.push(['packages/sdk-python/pyproject.toml', staticVersion])
} else if (isDynamic) {
  const hatchPath = pyproject.match(/^\[tool\.hatch\.version\]\s*$[\s\S]*?^path\s*=\s*['"]([^'"]+)['"]/m)?.[1]
  if (hatchPath !== 'invoice_ai/_version.py') {
    problems.push(
      `packages/sdk-python/pyproject.toml: version is dynamic but [tool.hatch.version] path is ${hatchPath ? `"${hatchPath}"` : 'missing'}; expected "invoice_ai/_version.py"`,
    )
  }
} else {
  problems.push('packages/sdk-python/pyproject.toml: [project] has neither a version nor dynamic = ["version"]')
}

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const PEP440 = /^\d+\.\d+\.\d+(?:(?:a|b|rc)\d+)?$/
const isPython = (file) => file.startsWith('packages/sdk-python/')

/**
 * npm and PyPI spell pre-releases differently (`0.1.0-rc.0` vs `0.1.0rc0`), so
 * compare the PEP 440 form: `-alpha.N`/`-beta.N`/`-rc.N` → `aN`/`bN`/`rcN`.
 */
function canonical(version) {
  const m = version.match(/^(\d+\.\d+\.\d+)-(alpha|beta|rc)\.(\d+)$/)
  return m ? `${m[1]}${{ alpha: 'a', beta: 'b', rc: 'rc' }[m[2]]}${m[3]}` : version
}

const width = Math.max(...found.map(([f]) => f.length))
for (const [file, version] of found) {
  console.log(`  ${file.padEnd(width)}  ${version ?? '(missing)'}`)
  if (!version) continue
  if (isPython(file) ? !PEP440.test(version) : !SEMVER.test(version)) {
    problems.push(`${file}: "${version}" is not a valid ${isPython(file) ? 'PEP 440' : 'semver'} release version`)
  }
}
if (!staticVersion && isDynamic) console.log(`  ${'packages/sdk-python/pyproject.toml'.padEnd(width)}  dynamic (from _version.py)`)

const versions = new Set(found.map(([, v]) => v && canonical(v)).filter(Boolean))
if (versions.size > 1) {
  problems.push(`versions disagree: ${[...versions].join(', ')}. Bump them together (they ship as one release).`)
}

if (problems.length) {
  for (const p of problems) {
    console.error(`error: ${p}`)
    if (process.env.GITHUB_ACTIONS) console.log(`::error::${p}`)
  }
  process.exit(1)
}
console.log(`All package versions match: ${[...versions][0]}`)
