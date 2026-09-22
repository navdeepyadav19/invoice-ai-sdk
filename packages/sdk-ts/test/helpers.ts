import { InvoiceAI, type ClientOptions } from '../src/index'

export const API_KEY = 'inv_live_ab12cd34_7Kf9QmXz2pR4vNt6LwYb8HsJ3dGc5eAu'
export const BASE = 'https://api.test/api/v1'

export interface RecordedRequest {
  url: URL
  method: string
  headers: Headers
  body: unknown
  signal: AbortSignal | undefined
}

type Step = Response | Error | ((req: RecordedRequest) => Response | Error | Promise<Response | Error>)

/**
 * A fetch that plays back `steps` in order (the last one repeats) and records
 * every request it receives.
 */
export function fakeFetch(...steps: Step[]) {
  const calls: RecordedRequest[] = []
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw = typeof init?.body === 'string' ? init.body : undefined
    const req: RecordedRequest = {
      url: new URL(String(input)),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: raw === undefined ? undefined : JSON.parse(raw),
      signal: init?.signal ?? undefined,
    }
    calls.push(req)
    if (init?.signal?.aborted) throw init.signal.reason ?? new DOMException('aborted', 'AbortError')
    const step = steps[Math.min(calls.length - 1, steps.length - 1)]!
    const out = typeof step === 'function' ? await step(req) : step
    if (out instanceof Error) throw out
    return out.clone()
  }
  return { fetch: fetchImpl as typeof fetch, calls }
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'x-request-id': 'req_test123', ...headers },
  })
}

export function problem(
  status: number,
  code: string,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Response {
  return new Response(
    JSON.stringify({
      type: `https://invoice.horizonpay.co/problems/${code.replace(/_/g, '-')}`,
      title: code,
      status,
      detail: `detail for ${code}`,
      instance: 'req_problem',
      code,
      ...extra,
    }),
    { status, headers: { 'content-type': 'application/problem+json', 'x-request-id': 'req_err42', ...headers } },
  )
}

/** A network failure shaped like undici's: TypeError('fetch failed') with a coded cause. */
export function networkError(code: string): Error {
  const cause = Object.assign(new Error(`connect ${code}`), { code })
  return new TypeError('fetch failed', { cause })
}

export function client(fetchImpl: typeof fetch, options: ClientOptions = {}): InvoiceAI {
  return new InvoiceAI({
    apiKey: API_KEY,
    baseURL: BASE,
    fetch: fetchImpl,
    initialRetryDelay: 1,
    maxRetryDelay: 4,
    logLevel: 'off',
    ...options,
  })
}

export const customer = (id: string) => ({
  id,
  object: 'customer',
  name: `Customer ${id}`,
  email: null,
  phone: null,
  tax_id: null,
  address: null,
  deleted: false,
  created: '2026-09-22T09:30:00.000Z',
})
