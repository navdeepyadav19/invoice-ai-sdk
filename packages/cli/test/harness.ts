import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { memoryStore, type SecretStore } from '../src/auth/keychain'
import type { Deps, OutStream } from '../src/deps'
import { run } from '../src/run'

export const KEY = 'inv_live_ab12cd34_secretpart0123456789'
export const API = 'https://api.test/api/v1'

export interface Captured extends OutStream {
  text: string
  chunks: (string | Uint8Array)[]
}

export function capture(isTTY = false): Captured {
  const s: Captured = {
    text: '',
    chunks: [],
    isTTY,
    write(chunk) {
      s.chunks.push(chunk)
      s.text += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk)
      return true
    },
  }
  return s
}

export type Handler = (req: { method: string; url: URL; headers: Headers; body: string }) => Response | Promise<Response>

/** A fetch that routes to `handler` and records every request. */
export function fakeFetch(handler: Handler) {
  const calls: { method: string; url: URL; headers: Headers; body: string }[] = []
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const method = (init?.method ?? 'GET').toUpperCase()
    const headers = new Headers(init?.headers)
    const body = typeof init?.body === 'string' ? init.body : init?.body ? String(init.body) : ''
    const req = { method, url, headers, body }
    calls.push(req)
    return handler(req)
  }) as typeof fetch
  return Object.assign(f, { calls })
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

export const problem = (status: number, code: string, detail: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ type: `https://invoice.horizonpay.co/errors/${code}`, title: code, status, code, detail, instance: 'req_test123', ...extra }), {
    status,
    headers: { 'content-type': 'application/problem+json', 'x-request-id': 'req_test123', ...headers },
  })

export interface Harness {
  deps: Deps
  stdout: Captured
  stderr: Captured
  secrets: SecretStore & { data: Map<string, string> }
  configDir: string
  opened: string[]
  sleeps: number[]
  run(...argv: string[]): Promise<number>
}

export function harness(opts: {
  fetch?: typeof fetch
  env?: Record<string, string | undefined>
  tty?: boolean
  keychain?: boolean
} = {}): Harness {
  const configDir = mkdtempSync(join(tmpdir(), 'invoice-ai-cli-test-'))
  const stdout = capture(opts.tty ?? false)
  const stderr = capture(opts.tty ?? false)
  const secrets = memoryStore({}, opts.keychain ?? true)
  const opened: string[] = []
  const sleeps: number[] = []
  let clock = Date.parse('2026-09-22T10:00:00Z')
  const deps: Deps = {
    env: { INVOICE_AI_CONFIG_DIR: configDir, INVOICE_AI_BASE_URL: API, INVOICE_AI_MAX_RETRIES: '0', ...opts.env },
    stdout,
    stderr,
    stdinIsTTY: opts.tty ?? false,
    readStdin: async () => '',
    fetch: opts.fetch ?? (fakeFetch(() => json({ error: 'no handler' }, 500)) as typeof fetch),
    sleep: async (ms) => {
      sleeps.push(ms)
      clock += ms
    },
    now: () => clock,
    openUrl: async (u) => {
      opened.push(u)
    },
    secretStore: secrets,
    hostname: () => 'test-host',
    platform: 'linux',
    arch: 'x64',
  }
  return {
    deps,
    stdout,
    stderr,
    secrets,
    configDir,
    opened,
    sleeps,
    run: (...argv) => run(argv, deps),
  }
}

// ---------------------------------------------------------------- fixtures

export const customer = (over: Record<string, unknown> = {}) => ({
  id: 'cus_A1',
  object: 'customer',
  name: 'Acme Corp',
  email: 'ap@acme.example',
  phone: null,
  tax_id: null,
  address: {},
  deleted: false,
  created: '2026-09-01T12:00:00Z',
  ...over,
})

export const invoice = (over: Record<string, unknown> = {}) => ({
  id: 'in_1',
  object: 'invoice',
  number: 'INV-0001',
  status: 'draft',
  customer: 'cus_A1',
  currency: 'USD',
  collection_method: 'send_invoice',
  issue_date: '2026-09-22',
  due_date: '2026-10-22',
  description: null,
  footer: null,
  subtotal: 5000,
  discount: 0,
  taxable: 5000,
  tax: 0,
  total: 5000,
  amount_due: 5000,
  amount_in_words: null,
  public_url_token: 'tok_abc',
  finalized_at: null,
  paid_at: null,
  voided_at: null,
  void_reason: null,
  created: '2026-09-22T10:00:00Z',
  updated: '2026-09-22T10:00:00Z',
  lines: { data: [] },
  ...over,
})
