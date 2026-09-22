import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CLI_VERSION, PACKAGE_NAME } from '../constants'

/**
 * "Update available" notices, checked at most once a day.
 *
 * Never blocks: the check runs in a detached child process that writes
 * `update-check.json` in the config dir; this run only reads what an earlier
 * run stored. Off in CI, when stderr isn't a terminal, and with
 * NO_UPDATE_NOTIFIER or INVOICE_AI_NO_UPDATE_CHECK set.
 */

const DAY_MS = 24 * 60 * 60 * 1000

interface Cache {
  checked_at: number
  latest?: string
}

export interface NotifierInput {
  env: Record<string, string | undefined>
  stderrIsTTY: boolean
  configDir: string
  now: number
  /** Starts the background refresh; replaced in tests. */
  refresh?: (cacheFile: string) => void
}

export function updatesEnabled(env: Record<string, string | undefined>, stderrIsTTY: boolean): boolean {
  if (!stderrIsTTY) return false
  if (env.CI && env.CI !== 'false' && env.CI !== '0') return false
  if (env.NO_UPDATE_NOTIFIER || env.INVOICE_AI_NO_UPDATE_CHECK) return false
  return true
}

/** Returns the notice to print after the command, if a newer version is known. */
export function checkForUpdate(input: NotifierInput): string | undefined {
  if (!updatesEnabled(input.env, input.stderrIsTTY)) return undefined
  const file = join(input.configDir, 'update-check.json')
  let cache: Cache | undefined
  try {
    cache = JSON.parse(readFileSync(file, 'utf8')) as Cache
  } catch {
    cache = undefined
  }

  if (!cache || typeof cache.checked_at !== 'number' || input.now - cache.checked_at > DAY_MS) {
    try {
      // Stamp first, so a burst of commands starts one check, not one each.
      mkdirSync(input.configDir, { recursive: true, mode: 0o700 })
      writeFileSync(file, JSON.stringify({ checked_at: input.now, latest: cache?.latest }))
      ;(input.refresh ?? spawnRefresh)(file)
    } catch {
      // Read-only home, no spawn: skip quietly.
    }
  }

  const latest = cache?.latest
  if (latest && isNewer(latest, CLI_VERSION)) {
    return `Update available ${CLI_VERSION} → ${latest}. Run: npm i -g ${PACKAGE_NAME}`
  }
  return undefined
}

/** Plain semver comparison of x.y.z (pre-release tags are never "newer"). */
export function isNewer(candidate: string, current: string): boolean {
  if (candidate.includes('-')) return false
  const a = candidate.split('.').map((n) => Number.parseInt(n, 10))
  const b = current.split('-')[0]!.split('.').map((n) => Number.parseInt(n, 10))
  for (let i = 0; i < 3; i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (Number.isNaN(x) || Number.isNaN(y)) return false
    if (x !== y) return x > y
  }
  return false
}

function spawnRefresh(cacheFile: string): void {
  const url = `https://registry.npmjs.org/${PACKAGE_NAME.replace('/', '%2F')}/latest`
  const script = `
    const fs = require('node:fs');
    const [url, file] = process.argv.slice(1);
    fetch(url, { signal: AbortSignal.timeout(5000), headers: { accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (j && typeof j.version === 'string') fs.writeFileSync(file, JSON.stringify({ checked_at: Date.now(), latest: j.version }));
      })
      .catch(() => {});
  `
  const child = spawn(process.execPath, ['-e', script, url, cacheFile], { detached: true, stdio: 'ignore' })
  child.on('error', () => undefined)
  child.unref()
}
