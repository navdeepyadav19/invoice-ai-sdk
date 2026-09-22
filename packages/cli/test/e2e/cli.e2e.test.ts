/**
 * End to end: the BUILT binary (dist/index.js), spawned with execa, against a
 * Prism mock of api-docs/openapi.json. Prism runs with --errors, so a request
 * the spec wouldn't accept fails the command instead of passing silently.
 *
 *   pnpm --filter @horizonpay/invoice-ai build
 *   pnpm --filter @horizonpay/invoice-ai-cli build
 *   pnpm --filter @horizonpay/invoice-ai-cli test:e2e
 *
 * If Prism can't be downloaded or started (offline, no npx), the tests skip.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const SPEC = fileURLToPath(new URL('../../../../api-docs/openapi.json', import.meta.url))
const BIN = fileURLToPath(new URL('../../dist/index.js', import.meta.url))
const KEY = 'inv_live_ab12cd34_e2eTestKey'

let prism: ChildProcess | undefined
let baseURL: string | undefined
let prismExited = false

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      srv.close(() => resolve(typeof addr === 'object' && addr ? addr.port : 4011))
    })
  })
}

async function waitForPrism(url: string, deadline: number): Promise<boolean> {
  while (Date.now() < deadline) {
    if (prismExited) return false
    try {
      await fetch(`${url}/business`)
      return true
    } catch {
      await new Promise((r) => setTimeout(r, 500))
    }
  }
  return false
}

beforeAll(async () => {
  if (!existsSync(BIN)) throw new Error(`Build the CLI first: ${BIN} is missing.`)
  const port = await freePort()
  try {
    prism = spawn(
      'npx',
      ['--yes', '@stoplight/prism-cli@5', 'mock', '--host', '127.0.0.1', '--port', String(port), '--errors', SPEC],
      { stdio: 'ignore', shell: process.platform === 'win32' },
    )
    prism.on('error', () => (prismExited = true))
    prism.on('exit', () => (prismExited = true))
  } catch {
    return
  }
  const url = `http://127.0.0.1:${port}`
  if (await waitForPrism(url, Date.now() + 150_000)) baseURL = url
  else console.warn('[e2e] Prism did not start; skipping CLI e2e tests.')
}, 180_000)

afterAll(() => {
  prism?.kill()
})

function cli(args: string[], env: Record<string, string> = {}) {
  return execa('node', [BIN, ...args], {
    reject: false,
    env: {
      INVOICE_AI_API_KEY: KEY,
      INVOICE_AI_BASE_URL: baseURL!,
      INVOICE_AI_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'invoice-ai-e2e-')),
      INVOICE_AI_NO_KEYCHAIN: '1',
      INVOICE_AI_MAX_RETRIES: '0',
      NO_COLOR: '1',
      CI: '1',
      ...env,
    },
    extendEnv: true,
    timeout: 20_000,
  })
}

describe('invoice-ai (built) against a Prism mock', () => {
  it('--help works without any configuration', async () => {
    const res = await execa('node', [BIN, '--help'], { reject: false })
    expect(res.exitCode).toBe(0)
    expect(res.stdout).toContain('Usage: invoice-ai')
  })

  it('customers list --json prints the page', async (t) => {
    if (!baseURL) return t.skip()
    const res = await cli(['customers', 'list', '--limit', '2', '--json'])
    expect(res.stderr).toBe('')
    expect(res.exitCode).toBe(0)
    const page = JSON.parse(res.stdout)
    expect(Array.isArray(page.data)).toBe(true)
    expect(page.data[0].id).toMatch(/^cus_/)
    expect(page).toHaveProperty('next_cursor')
  })

  it('customers list --format table renders a table', async (t) => {
    if (!baseURL) return t.skip()
    const res = await cli(['customers', 'list', '--format', 'table'])
    expect(res.exitCode).toBe(0)
    expect(res.stdout.split('\n')[0]).toMatch(/^ID\s+NAME\s+EMAIL\s+CREATED/)
  })

  it('invoices create with flags (non-interactive) returns the invoice', async (t) => {
    if (!baseURL) return t.skip()
    const res = await cli([
      'invoices', 'create',
      '--customer', 'cus_Nf3kQ8pR2mX7vB1cT9wL4sZ6',
      '--price', 'price_Jc5Tn8Wq1Ze6Ra3Ym9Ub2Gs7', '--qty', '2',
      '--json',
    ])
    expect(res.exitCode, res.stderr).toBe(0)
    const inv = JSON.parse(res.stdout)
    expect(inv.object).toBe('invoice')
    expect(inv.id).toMatch(/^in_/)
    expect(res.stderr).toContain('Created draft invoice')
  })

  it('whoami --json reads the business through the SDK', async (t) => {
    if (!baseURL) return t.skip()
    const res = await cli(['whoami', '--json'])
    expect(res.exitCode, res.stderr).toBe(0)
    expect(JSON.parse(res.stdout)).toMatchObject({ key: 'inv_live_ab12cd34…', key_source: 'INVOICE_AI_API_KEY' })
  })

  it('api GET /business passes the raw body through', async (t) => {
    if (!baseURL) return t.skip()
    const res = await cli(['api', 'GET', '/business'])
    expect(res.exitCode, res.stderr).toBe(0)
    expect(JSON.parse(res.stdout).data).toHaveProperty('legal_name')
  })

  it('exits 3 without credentials and 2 on usage errors', async (t) => {
    if (!baseURL) return t.skip()
    expect((await cli(['customers', 'list'], { INVOICE_AI_API_KEY: '' })).exitCode).toBe(3)
    expect((await cli(['invoices', 'list', '--status', 'nope'])).exitCode).toBe(2)
  })
})
