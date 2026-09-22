import { describe, expect, it } from 'vitest'
import {
  APIConnectionError,
  AuthenticationError,
  InvalidStateError,
  NotFoundError,
  PermissionError,
  RateLimitError,
  ValidationError,
} from '@horizonpay/invoice-ai'
import { CliError, ExitCode, exitCodeFor, formatError } from '../src/errors'
import { makeColors } from '../src/util/colors'
import { fakeFetch, harness, json, problem } from './harness'

const env = { INVOICE_AI_API_KEY: 'inv_live_ab12cd34_x' }
const init = (status: number, code: string) => ({
  status,
  body: { code, detail: `${code} detail` },
  headers: new Headers({ 'x-request-id': 'req_1' }),
})

describe('exitCodeFor (SDK error → exit code)', () => {
  it.each([
    [new AuthenticationError(init(401, 'unauthorized')), ExitCode.AUTH],
    [new PermissionError(init(403, 'forbidden')), ExitCode.AUTH],
    [new RateLimitError(init(429, 'rate_limited')), ExitCode.RATE_LIMITED],
    [new NotFoundError(init(404, 'not_found')), ExitCode.API],
    [new InvalidStateError(init(409, 'invalid_state')), ExitCode.API],
    [new ValidationError(init(422, 'validation')), ExitCode.API],
    [new APIConnectionError(), ExitCode.API],
    [new CliError('bad flag', ExitCode.USAGE), ExitCode.USAGE],
    [new Error('boom'), ExitCode.API],
  ])('%s → %i', (err, code) => {
    expect(exitCodeFor(err)).toBe(code)
  })
})

describe('formatError', () => {
  it('prints code, status, detail, field errors and request_id', () => {
    const err = new ValidationError({
      status: 422,
      body: { code: 'validation', detail: 'Some fields are invalid.', errors: [{ path: 'email', message: 'Invalid email' }] },
      headers: new Headers({ 'x-request-id': 'req_abc' }),
    })
    expect(formatError(err, makeColors(false))).toBe(
      'Error: validation (422)\n  Some fields are invalid.\n  email: Invalid email\n  request_id: req_abc',
    )
  })

  it('adds the missing scope and a hint for 403', () => {
    const err = new PermissionError({
      status: 403,
      body: { code: 'forbidden', detail: 'This key lacks the invoices:write scope.' },
      headers: new Headers(),
    })
    const text = formatError(err, makeColors(false))
    expect(text).toContain('missing scope: invoices:write')
    expect(text).toContain('invoice-ai login')
  })
})

describe('exit codes end to end', () => {
  const cases: [string, () => Response, number, string][] = [
    ['401', () => problem(401, 'unauthorized', 'Invalid API key.'), ExitCode.AUTH, 'unauthorized (401)'],
    ['403', () => problem(403, 'forbidden', 'Missing scope clients:read.'), ExitCode.AUTH, 'missing scope: clients:read'],
    ['404', () => problem(404, 'not_found', 'No such customer.'), ExitCode.API, 'not_found (404)'],
    ['429', () => problem(429, 'rate_limited', 'Slow down.', {}, { 'retry-after': '7' }), ExitCode.RATE_LIMITED, 'retry after: 7s'],
    ['500', () => problem(500, 'internal_error', 'Oops.'), ExitCode.API, 'internal_error (500)'],
  ]
  for (const [name, respond, code, text] of cases) {
    it(`HTTP ${name} → exit ${code}`, async () => {
      const h = harness({ fetch: fakeFetch(respond), env })
      expect(await h.run('customers', 'get', 'cus_missing')).toBe(code)
      expect(h.stderr.text).toContain(text)
      expect(h.stderr.text).toContain('request_id: req_test123')
      expect(h.stdout.text).toBe('')
    })
  }

  it('usage errors exit 2', async () => {
    const h = harness({ env })
    expect(await h.run('invoices', 'list', '--status', 'weird')).toBe(ExitCode.USAGE)
    expect(await h.run('customers', 'get')).toBe(ExitCode.USAGE)
    expect(await h.run('nope')).toBe(ExitCode.USAGE)
    expect(await h.run('customers', 'list', '--limit', 'abc')).toBe(ExitCode.USAGE)
    expect(h.stderr.text).toContain("Unknown command 'nope'")
  })

  it('no credentials exits 3 before any request', async () => {
    const f = fakeFetch(() => json({}))
    const h = harness({ fetch: f })
    expect(await h.run('invoices', 'list')).toBe(ExitCode.AUTH)
    expect(f.calls).toHaveLength(0)
    expect(h.stderr.text).toContain('Not logged in')
  })
})

describe('confirmation and prompts without a TTY', () => {
  it('destructive commands refuse without --yes (exit 2) and make no request', async () => {
    const f = fakeFetch(() => json({ data: {} }))
    const h = harness({ fetch: f, env })
    expect(await h.run('invoices', 'void', 'in_1', '--reason', 'dup')).toBe(ExitCode.USAGE)
    expect(h.stderr.text).toContain('--yes')
    expect(f.calls).toHaveLength(0)
  })

  it('--yes skips the confirmation', async () => {
    const f = fakeFetch(({ method, url, body }) => {
      expect([method, url.pathname]).toEqual(['POST', '/api/v1/invoices/in_1/void'])
      expect(JSON.parse(body)).toEqual({ reason: 'dup' })
      return json({ data: { id: 'in_1', status: 'void', number: 'INV-1', currency: 'USD' } })
    })
    const h = harness({ fetch: f, env })
    expect(await h.run('invoices', 'void', 'in_1', '--reason', 'dup', '--yes')).toBe(0)
    expect(JSON.parse(h.stdout.text).status).toBe('void')
  })

  it('the invoice wizard needs a TTY (exit 2 with a flags hint)', async () => {
    const h = harness({ env })
    expect(await h.run('invoices', 'create')).toBe(ExitCode.USAGE)
    expect(h.stderr.text).toContain('--customer')
  })
})
