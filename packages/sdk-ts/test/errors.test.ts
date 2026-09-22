import { describe, expect, it } from 'vitest'
import {
  APIError,
  AuthenticationError,
  ConflictError,
  ERROR_CLASS_BY_CODE,
  IdempotencyError,
  IdempotencyKeyRequiredError,
  InternalServerError,
  InvalidStateError,
  InvoiceAIError,
  NotFoundError,
  PermissionError,
  RateLimitError,
  UpstreamError,
  ValidationError,
} from '../src/index'
import { makeAPIError } from '../src/core/errors'
import { client, fakeFetch, problem } from './helpers'

const CASES = [
  [401, 'unauthorized', AuthenticationError],
  [403, 'forbidden', PermissionError],
  [404, 'not_found', NotFoundError],
  [409, 'invalid_state', InvalidStateError],
  [409, 'conflict', ConflictError],
  [422, 'validation', ValidationError],
  [422, 'idempotency_mismatch', IdempotencyError],
  [428, 'idempotency_key_required', IdempotencyKeyRequiredError],
  [429, 'rate_limited', RateLimitError],
  [500, 'internal_error', InternalServerError],
  [502, 'upstream_failed', UpstreamError],
] as const

describe('error mapping', () => {
  it.each(CASES)('%i %s → %o', async (status, code, Cls) => {
    const { fetch } = fakeFetch(problem(status, code, {}, { 'retry-after': '1' }))
    const err = await client(fetch, { maxRetries: 0 }).customers.retrieve('cus_1').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Cls)
    expect(err).toBeInstanceOf(APIError)
    expect(err).toBeInstanceOf(InvoiceAIError)
    const e = err as APIError
    expect(e.status).toBe(status)
    expect(e.code).toBe(code)
    expect(e.detail).toBe(`detail for ${code}`)
    expect(e.requestId).toBe('req_err42')
    expect(e.type).toContain('/problems/')
    expect(e.message).toBe(`${status} ${code}: detail for ${code} (request req_err42)`)
    expect(e.name).toBe(Cls.name)
  })

  it('covers every documented code', () => {
    expect(Object.keys(ERROR_CLASS_BY_CODE).sort()).toEqual(CASES.map(([, code]) => code).sort())
  })

  it('keeps field errors on ValidationError and lists them in the message', () => {
    const err = makeAPIError({
      status: 422,
      headers: new Headers({ 'x-request-id': 'req_v' }),
      body: {
        code: 'validation',
        detail: 'Some fields need attention.',
        errors: [
          { path: 'customer', message: 'Required' },
          { path: 'items.0.unit_amount', message: 'Use whole minor units' },
        ],
      },
    })
    expect(err).toBeInstanceOf(ValidationError)
    expect(err.fields).toHaveLength(2)
    expect(err.message).toBe(
      '422 validation: Some fields need attention. [customer: Required; items.0.unit_amount: Use whole minor units] (request req_v)',
    )
  })

  it('falls back to the problem instance when X-Request-Id is missing', () => {
    const err = makeAPIError({ status: 404, headers: new Headers(), body: { code: 'not_found', instance: 'req_inst' } })
    expect(err.requestId).toBe('req_inst')
    expect(err.message).toContain('(request req_inst)')
  })

  it('maps by status when the body has no code (e.g. an HTML proxy page)', () => {
    const h = new Headers()
    expect(makeAPIError({ status: 503, headers: h, body: '<html>' })).toBeInstanceOf(UpstreamError)
    expect(makeAPIError({ status: 500, headers: h, body: undefined })).toBeInstanceOf(InternalServerError)
    expect(makeAPIError({ status: 401, headers: h, body: undefined })).toBeInstanceOf(AuthenticationError)
    expect(makeAPIError({ status: 418, headers: h, body: undefined }).constructor).toBe(APIError)
  })

  it('PermissionError names the missing scope', async () => {
    const fromDetail = makeAPIError({
      status: 403,
      headers: new Headers(),
      body: { code: 'forbidden', detail: 'This credential is missing the invoices:write scope.' },
    }) as PermissionError
    expect(fromDetail.requiredScope).toBe('invoices:write')

    const { fetch } = fakeFetch(problem(403, 'forbidden', { detail: 'Insufficient scope' }))
    const err = (await client(fetch).invoices.finalize('in_1').catch((e: unknown) => e)) as PermissionError
    expect(err.requiredScope).toBe('invoices:finalize') // from the spec's x-required-scope
  })

  it('RateLimitError exposes retryAfter', () => {
    const err = makeAPIError({
      status: 429,
      headers: new Headers({ 'retry-after': '42' }),
      body: { code: 'rate_limited' },
    }) as RateLimitError
    expect(err.retryAfter).toBe(42)
  })
})
