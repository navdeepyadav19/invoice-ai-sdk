import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  APIConnectionError,
  APITimeoutError,
  APIUserAbortError,
  ConflictError,
  InternalServerError,
  InvalidStateError,
  NotFoundError,
  RateLimitError,
  UpstreamError,
  ValidationError,
} from '../src/index'
import { computeBackoff, serverRequestedDelay, shouldRetry } from '../src/core/http'
import { client, customer, fakeFetch, json, networkError, problem } from './helpers'

afterEach(() => {
  vi.useRealTimers()
})

const ok = () => json(200, { data: customer('cus_1') })
const created = () => json(201, { data: customer('cus_1') })

/** Wraps a fetch to record when each attempt started (real clock). */
function timed(f: typeof fetch) {
  const at: number[] = []
  const wrapped: typeof fetch = (input, init) => {
    at.push(performance.now())
    return f(input, init)
  }
  return { fetch: wrapped, gap: () => at[1]! - at[0]! }
}

describe('retries', () => {
  it('retries a 429 after the Retry-After seconds, not the (much shorter) backoff', async () => {
    const { fetch, calls } = fakeFetch(problem(429, 'rate_limited', {}, { 'retry-after': '0.25' }), ok())
    const t = timed(fetch)
    await expect(client(t.fetch).customers.retrieve('cus_1')).resolves.toMatchObject({ id: 'cus_1' })
    expect(calls).toHaveLength(2)
    expect(t.gap()).toBeGreaterThanOrEqual(240)
    expect(t.gap()).toBeLessThan(1500)
  })

  it('falls back to RateLimit-Reset as a Unix timestamp', async () => {
    // Freeze Date 0.7s into a second; the window resets on the next second → wait 300ms.
    vi.useFakeTimers({ toFake: ['Date'], now: 1_789_371_000_700 })
    const { fetch, calls } = fakeFetch(problem(429, 'rate_limited', {}, { 'ratelimit-reset': '1789371001' }), ok())
    const t = timed(fetch)
    await client(t.fetch).customers.retrieve('cus_1')
    expect(calls).toHaveLength(2)
    expect(t.gap()).toBeGreaterThanOrEqual(290)
    expect(t.gap()).toBeLessThan(1500)
  })

  it('gives up on a 429 whose Retry-After exceeds maxRetryAfter', async () => {
    const { fetch, calls } = fakeFetch(problem(429, 'rate_limited', {}, { 'retry-after': '3600' }), ok())
    const err = await client(fetch).customers.retrieve('cus_1').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RateLimitError)
    expect((err as RateLimitError).retryAfter).toBe(3600)
    expect(calls).toHaveLength(1)
  })

  it('retries 503 and 500 then succeeds', async () => {
    const { fetch, calls } = fakeFetch(problem(503, 'upstream_failed'), problem(500, 'internal_error'), ok())
    await expect(client(fetch).customers.retrieve('cus_1')).resolves.toMatchObject({ id: 'cus_1' })
    expect(calls).toHaveLength(3)
  })

  it('throws the last error after maxRetries', async () => {
    const { fetch, calls } = fakeFetch(problem(500, 'internal_error'))
    await expect(client(fetch, { maxRetries: 3 }).customers.list()).rejects.toBeInstanceOf(InternalServerError)
    expect(calls).toHaveLength(4)
  })

  it('honours a per-request maxRetries', async () => {
    const { fetch, calls } = fakeFetch(problem(502, 'upstream_failed'))
    await expect(client(fetch).customers.retrieve('cus_1', { maxRetries: 0 })).rejects.toBeInstanceOf(UpstreamError)
    expect(calls).toHaveLength(1)
  })

  it('retries network errors', async () => {
    const { fetch, calls } = fakeFetch(networkError('ECONNRESET'), networkError('ECONNRESET'), ok())
    await expect(client(fetch).customers.retrieve('cus_1')).resolves.toMatchObject({ id: 'cus_1' })
    expect(calls).toHaveLength(3)
  })

  it('surfaces a network error as APIConnectionError once retries run out', async () => {
    const { fetch, calls } = fakeFetch(networkError('ECONNRESET'))
    const err = await client(fetch).customers.retrieve('cus_1').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(APIConnectionError)
    expect(String((err as Error).message)).toContain('ECONNRESET')
    expect(calls).toHaveLength(3)
  })

  it('retries 409 conflict (idempotent request in flight) but not invalid_state', async () => {
    const a = fakeFetch(problem(409, 'conflict'), created())
    await client(a.fetch).customers.create({ name: 'Acme' })
    expect(a.calls).toHaveLength(2)

    const b = fakeFetch(problem(409, 'invalid_state'))
    await expect(client(b.fetch).invoices.finalize('in_1')).rejects.toBeInstanceOf(InvalidStateError)
    expect(b.calls).toHaveLength(1)
  })

  it.each([
    [400, 'validation', ValidationError],
    [404, 'not_found', NotFoundError],
    [422, 'validation', ValidationError],
  ] as const)('does not retry %i %s', async (status, code, Cls) => {
    const { fetch, calls } = fakeFetch(problem(status, code))
    await expect(client(fetch).customers.retrieve('cus_1')).rejects.toBeInstanceOf(Cls)
    expect(calls).toHaveLength(1)
  })
})

describe('idempotency', () => {
  it('sends a generated UUID Idempotency-Key on POST and reuses it on every retry', async () => {
    const { fetch, calls } = fakeFetch(problem(503, 'upstream_failed'), networkError('ECONNRESET'), created())
    const { response } = await client(fetch).customers.create({ name: 'Acme' }).withResponse()
    expect(calls).toHaveLength(3)
    const keys = calls.map((c) => c.headers.get('idempotency-key'))
    expect(keys[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(new Set(keys).size).toBe(1)
    expect(response.idempotencyKey).toBe(keys[0])
    expect(response.attempts).toBe(3)
  })

  it('uses a fresh key for each separate call', async () => {
    const { fetch, calls } = fakeFetch(created())
    const c = client(fetch)
    await c.customers.create({ name: 'A' })
    await c.customers.create({ name: 'B' })
    expect(calls[0]!.headers.get('idempotency-key')).not.toBe(calls[1]!.headers.get('idempotency-key'))
  })

  it('uses the caller-supplied key across retries', async () => {
    const { fetch, calls } = fakeFetch(problem(500, 'internal_error'), json(200, { data: { id: 'in_1' } }))
    await client(fetch).invoices.finalize('in_1', { idempotencyKey: 'finalize-in_1-v1' })
    expect(calls.map((c) => c.headers.get('idempotency-key'))).toEqual(['finalize-in_1-v1', 'finalize-in_1-v1'])
  })

  it('does not send a key on GET, PATCH or DELETE', async () => {
    const { fetch, calls } = fakeFetch(ok())
    const c = client(fetch)
    await c.customers.retrieve('cus_1')
    await c.customers.update('cus_1', { name: 'X' })
    await c.customers.del('cus_1')
    expect(calls.map((x) => x.headers.get('idempotency-key'))).toEqual([null, null, null])
  })

  it('exposes Idempotent-Replayed on the response', async () => {
    const { fetch } = fakeFetch(json(201, { data: customer('cus_1') }, { 'idempotent-replayed': 'true' }))
    const { response } = await client(fetch).customers.create({ name: 'Acme' }).withResponse()
    expect(response.idempotentReplayed).toBe(true)
  })
})

describe('non-idempotent writes (PATCH/DELETE)', () => {
  it('does not retry a PATCH after a 503', async () => {
    const { fetch, calls } = fakeFetch(problem(503, 'upstream_failed'), ok())
    await expect(client(fetch).customers.update('cus_1', { name: 'X' })).rejects.toBeInstanceOf(UpstreamError)
    expect(calls).toHaveLength(1)
  })

  it('does not retry a DELETE after a connection reset (the server may have run it)', async () => {
    const { fetch, calls } = fakeFetch(networkError('ECONNRESET'), ok())
    await expect(client(fetch).customers.del('cus_1')).rejects.toBeInstanceOf(APIConnectionError)
    expect(calls).toHaveLength(1)
  })

  it('retries a PATCH when the connection was refused before sending', async () => {
    const { fetch, calls } = fakeFetch(networkError('ECONNREFUSED'), ok())
    await client(fetch).customers.update('cus_1', { name: 'X' })
    expect(calls).toHaveLength(2)
  })

  it('retries a DELETE on 429 (rejected before the handler ran)', async () => {
    const { fetch, calls } = fakeFetch(problem(429, 'rate_limited', {}, { 'retry-after': '0' }), ok())
    await client(fetch).customers.del('cus_1')
    expect(calls).toHaveLength(2)
  })
})

describe('timeouts and cancellation', () => {
  const hang = (req: { signal: AbortSignal | undefined }) =>
    new Promise<Response>((_, reject) => {
      req.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    })

  it('times out with APITimeoutError and retries GETs', async () => {
    const { fetch, calls } = fakeFetch(hang, hang, ok())
    await expect(client(fetch, { timeout: 20 }).customers.retrieve('cus_1')).resolves.toMatchObject({ id: 'cus_1' })
    expect(calls).toHaveLength(3)
  })

  it('throws APITimeoutError when every attempt times out', async () => {
    const { fetch, calls } = fakeFetch(hang)
    const err = await client(fetch, { maxRetries: 1 }).customers.retrieve('cus_1', { timeout: 10 }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(APITimeoutError)
    expect(err).toBeInstanceOf(APIConnectionError)
    expect(calls).toHaveLength(2)
  })

  it('does not retry a timed-out PATCH', async () => {
    const { fetch, calls } = fakeFetch(hang)
    await expect(client(fetch, { timeout: 10 }).customers.update('cus_1', { name: 'X' })).rejects.toBeInstanceOf(
      APITimeoutError,
    )
    expect(calls).toHaveLength(1)
  })

  it('stops on a user abort, without retrying', async () => {
    const { fetch, calls } = fakeFetch(hang)
    const controller = new AbortController()
    const pending = client(fetch).customers.retrieve('cus_1', { signal: controller.signal })
    setTimeout(() => controller.abort(), 5)
    await expect(pending).rejects.toBeInstanceOf(APIUserAbortError)
    expect(calls).toHaveLength(1)
  })
})

describe('request shape', () => {
  it('sends auth, version, user agent and JSON', async () => {
    const { fetch, calls } = fakeFetch(created())
    await client(fetch).customers.create({ name: 'Acme', email: 'ap@acme.example' })
    const req = calls[0]!
    expect(req.method).toBe('POST')
    expect(req.url.toString()).toBe('https://api.test/api/v1/customers')
    expect(req.headers.get('authorization')).toMatch(/^Bearer inv_live_/)
    expect(req.headers.get('invoice-ai-version')).toBeTruthy()
    expect(req.headers.get('user-agent')).toMatch(/^invoice-ai-node\/\d+\.\d+\.\d+ \(/)
    expect(req.headers.get('content-type')).toBe('application/json')
    expect(req.body).toEqual({ name: 'Acme', email: 'ap@acme.example' })
  })

  it('serialises query params and path params', async () => {
    const { fetch, calls } = fakeFetch(json(200, { data: [], next_cursor: null }))
    await client(fetch).invoices.list({ status: 'open', limit: 10 })
    await client(fetch).invoiceItems.del('ii_1/x', { invoice: 'in_9' })
    expect(calls[0]!.url.search).toBe('?status=open&limit=10')
    expect(calls[1]!.url.pathname).toBe('/api/v1/invoice-items/ii_1%2Fx')
    expect(calls[1]!.url.searchParams.get('invoice')).toBe('in_9')
  })

  it('returns rate-limit info and the request id via withResponse()', async () => {
    const { fetch } = fakeFetch(
      json(200, { data: customer('cus_1') }, { 'ratelimit-limit': '120', 'ratelimit-remaining': '119', 'ratelimit-reset': '1789371294' }),
    )
    const { data, response } = await client(fetch).customers.retrieve('cus_1').withResponse()
    expect(data.id).toBe('cus_1')
    expect(response.requestId).toBe('req_test123')
    expect(response.rateLimit).toEqual({ limit: 120, remaining: 119, reset: 1789371294 })
  })

  it('returns bytes for the PDF and undefined for 204s', async () => {
    const pdf = new Response(new Uint8Array([37, 80, 68, 70]), { status: 200, headers: { 'content-type': 'application/pdf' } })
    const { fetch } = fakeFetch(pdf, json(204, null))
    const c = client(fetch)
    const bytes = await c.invoices.pdf('in_1')
    expect(new Uint8Array(bytes)).toEqual(new Uint8Array([37, 80, 68, 70]))
    await expect(c.invoices.del('in_1')).resolves.toBeUndefined()
  })
})

describe('pure helpers', () => {
  it('shouldRetry encodes the method/status matrix', () => {
    expect(shouldRetry({ method: 'GET', status: 500 })).toBe(true)
    expect(shouldRetry({ method: 'POST', status: 502 })).toBe(true)
    expect(shouldRetry({ method: 'PATCH', status: 502 })).toBe(false)
    expect(shouldRetry({ method: 'DELETE', status: 429 })).toBe(true)
    expect(shouldRetry({ method: 'GET', status: 408 })).toBe(true)
    expect(shouldRetry({ method: 'POST', status: 409, code: 'conflict' })).toBe(true)
    expect(shouldRetry({ method: 'POST', status: 409, code: 'invalid_state' })).toBe(false)
    expect(shouldRetry({ method: 'GET', status: 404 })).toBe(false)
    expect(shouldRetry({ method: 'PATCH', failure: 'connection', preSend: true })).toBe(true)
    expect(shouldRetry({ method: 'PATCH', failure: 'connection', preSend: false })).toBe(false)
    expect(shouldRetry({ method: 'PATCH', failure: 'timeout' })).toBe(false)
  })

  it('computeBackoff doubles from 0.5s, caps at 8s and jitters down by at most 25%', () => {
    expect([0, 1, 2, 3, 4, 5].map((n) => computeBackoff(n, 500, 8000, () => 0))).toEqual([500, 1000, 2000, 4000, 8000, 8000])
    expect(computeBackoff(0, 500, 8000, () => 1)).toBe(375)
  })

  it('serverRequestedDelay reads Retry-After seconds, dates and RateLimit-Reset', () => {
    const now = 1_789_371_000_000
    expect(serverRequestedDelay(new Headers({ 'retry-after': '3' }), now)).toBe(3000)
    expect(serverRequestedDelay(new Headers({ 'retry-after': new Date(now + 5000).toUTCString() }), now)).toBe(5000)
    expect(serverRequestedDelay(new Headers({ 'ratelimit-reset': '1789371010' }), now)).toBe(10_000)
    expect(serverRequestedDelay(new Headers({ 'ratelimit-reset': '7' }), now)).toBe(7000)
    expect(serverRequestedDelay(new Headers(), now)).toBeUndefined()
  })

  it('maps ConflictError for 409 conflict', async () => {
    const { fetch } = fakeFetch(problem(409, 'conflict'))
    await expect(client(fetch, { maxRetries: 0 }).customers.create({ name: 'A' })).rejects.toBeInstanceOf(ConflictError)
  })
})
