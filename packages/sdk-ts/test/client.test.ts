import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { API_VERSION, DEFAULT_BASE_URL, InvoiceAI, InvoiceAIError, VERSION } from '../src/index'
import { redactApiKey, redactHeaders, redactSecrets, type Logger } from '../src/core/logger'
import { API_KEY, client, customer, fakeFetch, json, problem } from './helpers'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('configuration', () => {
  it('reads INVOICE_AI_API_KEY and INVOICE_AI_BASE_URL', async () => {
    vi.stubEnv('INVOICE_AI_API_KEY', API_KEY)
    vi.stubEnv('INVOICE_AI_BASE_URL', 'http://localhost:3000/api/v1')
    const { fetch, calls } = fakeFetch(json(200, { data: { id: 'biz' } }))
    const c = new InvoiceAI({ fetch })
    await c.business.retrieve()
    expect(calls[0]!.url.toString()).toBe('http://localhost:3000/api/v1/business')
    expect(calls[0]!.headers.get('authorization')).toBe(`Bearer ${API_KEY}`)
  })

  it('defaults to the production base URL', () => {
    vi.stubEnv('INVOICE_AI_BASE_URL', '')
    expect(new InvoiceAI({ apiKey: API_KEY }).baseURL).toBe(DEFAULT_BASE_URL)
  })

  it('fails early without a key, or with a malformed one', () => {
    vi.stubEnv('INVOICE_AI_API_KEY', '')
    expect(() => new InvoiceAI()).toThrow(InvoiceAIError)
    expect(() => new InvoiceAI()).toThrow(/INVOICE_AI_API_KEY/)
    expect(() => new InvoiceAI({ apiKey: 'sk_test_123' })).toThrow(/inv_live_/)
  })

  it('never exposes the key when the client is logged or serialised', () => {
    const c = new InvoiceAI({ apiKey: API_KEY })
    expect(JSON.stringify(Object.keys(c))).not.toContain('config')
    expect(Object.keys(c)).not.toContain('config')
  })

  it('refuses empty path params instead of calling /customers/undefined', () => {
    const { fetch } = fakeFetch(json(200, {}))
    expect(() => client(fetch).customers.retrieve(undefined as unknown as string)).toThrow(/`id` must be a non-empty string/)
  })

  it('VERSION matches package.json and API_VERSION comes from the spec', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
    const spec = JSON.parse(readFileSync(new URL('../../../api-docs/openapi.json', import.meta.url), 'utf8')) as {
      info: { version: string }
    }
    expect(VERSION).toBe(pkg.version)
    expect(API_VERSION).toBe(spec.info.version)
  })
})

describe('request() escape hatch', () => {
  it('returns the raw body with the same retries, idempotency and errors', async () => {
    const { fetch, calls } = fakeFetch(problem(503, 'upstream_failed'), json(200, { data: { id: 'x' }, extra: 1 }))
    const body = await client(fetch).request<{ data: { id: string }; extra: number }>('POST', '/things', {
      body: { a: 1 },
      query: { dry_run: true },
    })
    expect(body).toEqual({ data: { id: 'x' }, extra: 1 })
    expect(calls).toHaveLength(2)
    expect(calls[0]!.url.search).toBe('?dry_run=true')
    expect(calls[0]!.headers.get('idempotency-key')).toBe(calls[1]!.headers.get('idempotency-key'))
  })
})

describe('resource methods', () => {
  it('unwrap { data } for single objects', async () => {
    const { fetch } = fakeFetch(json(200, { data: customer('cus_9') }))
    const c = await client(fetch).customers.retrieve('cus_9')
    expect(c).toEqual(customer('cus_9'))
  })

  it('split query and body correctly for action endpoints', async () => {
    const { fetch, calls } = fakeFetch(json(200, { data: { id: 'in_1' } }))
    await client(fetch).invoices.void('in_1', { reason: 'Duplicate' })
    expect(calls[0]!.url.pathname).toBe('/api/v1/invoices/in_1/void')
    expect(calls[0]!.body).toEqual({ reason: 'Duplicate' })
  })

  it('pdfUrl builds an absolute URL', () => {
    const { fetch } = fakeFetch(json(200, {}))
    expect(client(fetch).invoices.pdfUrl('in_1', { download: '1' })).toBe('https://api.test/api/v1/invoices/in_1/pdf?download=1')
  })
})

describe('debug logging and redaction', () => {
  function capture(): { logger: Logger; lines: string[] } {
    const lines: string[] = []
    const push = (m: string, ...rest: unknown[]) => lines.push([m, ...rest.map((r) => JSON.stringify(r))].join(' '))
    return { logger: { debug: push, info: push, warn: push, error: push }, lines }
  }

  it('logs method, path, status, request id and retries, never the key', async () => {
    const { logger, lines } = capture()
    const { fetch } = fakeFetch(problem(500, 'internal_error'), json(201, { data: customer('cus_1') }))
    await client(fetch, { logLevel: 'debug', logger }).customers.create({ name: 'Acme' })
    const out = lines.join('\n')
    expect(out).toContain('→ POST /api/v1/customers')
    expect(out).toContain('← 500 POST /api/v1/customers (req_err42')
    expect(out).toMatch(/retrying POST \/api\/v1\/customers in \d+ms \(attempt 2 of 3\) after 500 internal_error/)
    expect(out).toContain('← 201 POST /api/v1/customers (req_test123')
    expect(out).toContain('Bearer inv_live_ab12cd34…')
    expect(out).not.toContain(API_KEY)
    expect(out).not.toContain('7Kf9QmXz2pR4vNt6LwYb8HsJ3dGc5eAu')
  })

  it('logs nothing below the chosen level', async () => {
    const { logger, lines } = capture()
    const { fetch } = fakeFetch(json(200, { data: customer('cus_1') }))
    await client(fetch, { logLevel: 'warn', logger }).customers.retrieve('cus_1')
    expect(lines).toEqual([])
  })

  it('honours INVOICE_AI_LOG=debug', async () => {
    vi.stubEnv('INVOICE_AI_LOG', 'debug')
    const { logger, lines } = capture()
    const { fetch } = fakeFetch(json(200, { data: customer('cus_1') }))
    await new InvoiceAI({ apiKey: API_KEY, baseURL: 'https://api.test', fetch, logger }).customers.retrieve('cus_1')
    expect(lines.length).toBeGreaterThan(0)
  })

  it('redaction helpers', () => {
    expect(redactApiKey(API_KEY)).toBe('inv_live_ab12cd34…')
    expect(redactApiKey('whatever-secret')).toBe('what…')
    expect(redactSecrets(`key=${API_KEY} secret=whsec_abc+/=`)).toBe('key=inv_live_ab12cd34… secret=whsec_…')
    expect(redactHeaders({ Authorization: `Bearer ${API_KEY}`, Cookie: 'a=b', 'Idempotency-Key': 'k' })).toEqual({
      authorization: 'Bearer inv_live_ab12cd34…',
      cookie: '[redacted]',
      'idempotency-key': 'k',
    })
  })
})
