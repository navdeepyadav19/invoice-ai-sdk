import { APIConnectionError, APITimeoutError, APIUserAbortError, makeAPIError } from './errors'
import { IDEMPOTENCY_HEADER, resolveIdempotencyKey } from './idempotency'
import { redactHeaders, type Logger } from './logger'
import { isBrowser, platformLabel } from './runtime'
import { API_VERSION, VERSION } from './version'

/**
 * The HTTP engine: one SDK call → one or more attempts.
 *
 * Retries (up to `maxRetries`, default 2) happen on:
 *   - network errors and timeouts,
 *   - 408, 409 `conflict` (an idempotent request is still in flight),
 *   - 429 (waiting for `Retry-After` / `RateLimit-Reset`),
 *   - any 5xx.
 * Backoff is exponential with jitter, 0.5s doubling to an 8s cap.
 *
 * Which methods may be retried:
 *   - GET/HEAD: always safe.
 *   - POST: always carries an Idempotency-Key that is reused on every retry,
 *     so the server replays instead of repeating the work.
 *   - PATCH/DELETE: no idempotency key on this API, so after the request may
 *     have reached the server we never resend it. They are retried only when
 *     the connection failed before anything was sent (DNS, refused), or on
 *     429, which the API returns before running the handler.
 */

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE' | 'HEAD'

/** Per-request overrides, always the last argument of every SDK method. */
export interface RequestOptions {
  /** Your own Idempotency-Key. Otherwise POSTs get a generated UUID. */
  idempotencyKey?: string
  /** Milliseconds per attempt before giving up. Default 60000. */
  timeout?: number
  /** Automatic retries for this call. Default 2. */
  maxRetries?: number
  /** Cancel the request (and any pending retry). */
  signal?: AbortSignal
  /** Extra headers for this call. */
  headers?: Record<string, string>
}

export interface ClientConfig {
  apiKey: string
  baseURL: string
  timeout: number
  maxRetries: number
  fetch: typeof fetch
  logger: Logger
  defaultHeaders: Record<string, string>
  /** First retry delay in ms (default 500). */
  initialRetryDelay: number
  /** Cap for the computed backoff in ms (default 8000). */
  maxRetryDelay: number
  /** Longest server-requested wait we'll sleep through, in ms (default 60000). */
  maxRetryAfter: number
}

export interface RequestSpec {
  method: HttpMethod
  /** Path under the base URL, e.g. `/invoices/in_123/finalize`. */
  path: string
  query?: Record<string, unknown> | undefined
  body?: unknown
  options?: RequestOptions | undefined
  /** `binary` returns an ArrayBuffer on success. */
  responseType?: 'json' | 'binary'
  /** Media type(s) of a binary response, e.g. `application/pdf`. */
  accept?: string
  /** The spec's `x-required-scope`, attached to 403 errors. */
  requiredScope?: string
}

export interface RateLimitInfo {
  limit: number | undefined
  remaining: number | undefined
  /** Unix seconds at which the window resets. */
  reset: number | undefined
}

/** Everything about the HTTP response besides the parsed data. */
export interface ResponseMeta {
  status: number
  headers: Headers
  url: string
  requestId: string | undefined
  /** True when the server replayed a stored response for this Idempotency-Key. */
  idempotentReplayed: boolean
  /** The Idempotency-Key that was sent, if any. */
  idempotencyKey: string | undefined
  rateLimit: RateLimitInfo
  /** How many attempts it took (1 = no retries). */
  attempts: number
}

export interface APIResponse {
  meta: ResponseMeta
  body: unknown
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/** Error codes that mean the connection failed before the request was written. */
const PRE_SEND_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EADDRNOTAVAIL',
  'UND_ERR_CONNECT_TIMEOUT',
  'CERT_HAS_EXPIRED',
])

export interface RetryContext {
  method: string
  status?: number
  code?: string
  /** For failures without a response. */
  failure?: 'timeout' | 'connection'
  /** The connection failed before any bytes were sent. */
  preSend?: boolean
}

/** Whether one failed attempt may be retried. Pure, so it's easy to test. */
export function shouldRetry(ctx: RetryContext): boolean {
  const method = ctx.method.toUpperCase()
  const replaySafe = SAFE_METHODS.has(method) || method === 'POST'
  if (ctx.failure === 'connection') return replaySafe || ctx.preSend === true
  if (ctx.failure === 'timeout') return replaySafe
  const status = ctx.status ?? 0
  if (status === 429) return true
  if (!replaySafe) return false
  if (status === 408) return true
  if (status === 409) return ctx.code === 'conflict'
  return status >= 500
}

/** Exponential backoff with jitter: base·2^n capped, minus up to 25%. */
export function computeBackoff(
  retryIndex: number,
  initialMs = 500,
  maxMs = 8000,
  random: () => number = Math.random,
): number {
  const base = Math.min(initialMs * 2 ** retryIndex, maxMs)
  return Math.round(base * (1 - 0.25 * random()))
}

/**
 * How long the server asked us to wait, in ms, or undefined.
 * `Retry-After` is seconds or an HTTP date. This API's `RateLimit-Reset` is a
 * Unix timestamp; values that look like deltas (< 1e9) are treated as seconds.
 */
export function serverRequestedDelay(headers: Headers, now: number = Date.now()): number | undefined {
  const retryAfter = headers.get('retry-after')
  if (retryAfter !== null && retryAfter.trim() !== '') {
    const secs = Number(retryAfter)
    if (Number.isFinite(secs)) return Math.max(0, secs * 1000)
    const date = Date.parse(retryAfter)
    if (!Number.isNaN(date)) return Math.max(0, date - now)
  }
  const reset = headers.get('ratelimit-reset')
  if (reset !== null && reset.trim() !== '') {
    const n = Number(reset)
    if (Number.isFinite(n)) return Math.max(0, n > 1e9 ? n * 1000 - now : n * 1000)
  }
  return undefined
}

export function parseRateLimit(headers: Headers): RateLimitInfo {
  const num = (name: string) => {
    const v = headers.get(name)
    const n = v === null ? NaN : Number(v)
    return Number.isFinite(n) ? n : undefined
  }
  return { limit: num('ratelimit-limit'), remaining: num('ratelimit-remaining'), reset: num('ratelimit-reset') }
}

export function buildURL(baseURL: string, path: string, query?: Record<string, unknown>): string {
  const url = new URL(baseURL.replace(/\/+$/, '') + (path.startsWith('/') ? path : `/${path}`))
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null) continue
    const values = Array.isArray(value) ? value : [value]
    for (const v of values) url.searchParams.append(key, v instanceof Date ? v.toISOString() : String(v))
  }
  return url.toString()
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new APIUserAbortError())
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new APIUserAbortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function isPreSendError(err: unknown): boolean {
  let e: unknown = err
  for (let depth = 0; depth < 4 && e && typeof e === 'object'; depth++) {
    const code = (e as { code?: unknown }).code
    if (typeof code === 'string' && PRE_SEND_CODES.has(code)) return true
    e = (e as { cause?: unknown }).cause
  }
  return false
}

async function readBody(res: Response, responseType: 'json' | 'binary'): Promise<unknown> {
  if (res.status === 204 || res.status === 205 || res.headers.get('content-length') === '0') {
    await res.body?.cancel().catch(() => {})
    return undefined
  }
  if (responseType === 'binary' && res.ok) return res.arrayBuffer()
  const text = await res.text()
  if (text === '') return undefined
  const type = res.headers.get('content-type') ?? ''
  if (type.includes('json')) {
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }
  return text
}

export function userAgent(): string {
  return `invoice-ai-node/${VERSION} (${platformLabel()})`
}

/** Runs one SDK call to completion: attempts, retries, parsing, error mapping. */
export async function executeRequest(config: ClientConfig, spec: RequestSpec): Promise<APIResponse> {
  const options = spec.options ?? {}
  const method = spec.method
  const maxRetries = Math.max(0, options.maxRetries ?? config.maxRetries)
  const timeout = options.timeout ?? config.timeout
  const url = buildURL(config.baseURL, spec.path, spec.query)
  const logger = config.logger
  const userSignal = options.signal

  // Chosen once, before the first attempt: every retry reuses it.
  const idempotencyKey = await resolveIdempotencyKey(method, options.idempotencyKey)

  const headers = new Headers({
    // Errors are always application/problem+json, so binary endpoints accept both.
    Accept: spec.accept ? `${spec.accept}, application/problem+json` : 'application/json',
    Authorization: `Bearer ${config.apiKey}`,
    'Invoice-AI-Version': API_VERSION,
  })
  if (!isBrowser()) headers.set('User-Agent', userAgent())
  for (const [k, v] of Object.entries(config.defaultHeaders)) headers.set(k, v)
  if (idempotencyKey) headers.set(IDEMPOTENCY_HEADER, idempotencyKey)
  let body: string | undefined
  if (spec.body !== undefined && method !== 'GET' && method !== 'HEAD') {
    body = JSON.stringify(spec.body)
    headers.set('Content-Type', 'application/json')
  }
  for (const [k, v] of Object.entries(options.headers ?? {})) headers.set(k, v)

  const pathForLog = new URL(url).pathname
  for (let attempt = 0; ; attempt++) {
    if (userSignal?.aborted) throw new APIUserAbortError()
    const started = Date.now()
    logger.debug(`→ ${method} ${pathForLog}${attempt ? ` (retry ${attempt})` : ''}`, {
      headers: redactHeaders(headers),
    })

    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeout)
    const onUserAbort = () => controller.abort()
    userSignal?.addEventListener('abort', onUserAbort, { once: true })

    let res: Response
    let parsed: unknown
    try {
      res = await config.fetch(url, { method, headers, body, signal: controller.signal })
      parsed = await readBody(res, spec.responseType ?? 'json')
    } catch (err) {
      if (userSignal?.aborted) throw new APIUserAbortError(undefined, { cause: err })
      const failure = timedOut ? 'timeout' : 'connection'
      const error = timedOut
        ? new APITimeoutError(`Request timed out after ${timeout}ms (${method} ${pathForLog}).`, { cause: err })
        : new APIConnectionError(`Connection error (${method} ${pathForLog}): ${describe(err)}`, { cause: err })
      if (attempt < maxRetries && shouldRetry({ method, failure, preSend: isPreSendError(err) })) {
        const delay = computeBackoff(attempt, config.initialRetryDelay, config.maxRetryDelay)
        logger.debug(`retrying ${method} ${pathForLog} in ${delay}ms after ${failure} error`)
        await sleep(delay, userSignal)
        continue
      }
      throw error
    } finally {
      clearTimeout(timer)
      userSignal?.removeEventListener('abort', onUserAbort)
    }

    const requestId = res.headers.get('x-request-id') ?? undefined
    logger.debug(`← ${res.status} ${method} ${pathForLog} (${requestId ?? 'no request id'}, ${Date.now() - started}ms)`)

    if (res.ok) {
      return {
        body: parsed,
        meta: {
          status: res.status,
          headers: res.headers,
          url,
          requestId,
          idempotentReplayed: res.headers.get('idempotent-replayed') === 'true',
          idempotencyKey,
          rateLimit: parseRateLimit(res.headers),
          attempts: attempt + 1,
        },
      }
    }

    const code = (parsed as { code?: unknown } | undefined)?.code
    if (attempt < maxRetries && shouldRetry({ method, status: res.status, code: typeof code === 'string' ? code : undefined })) {
      const requested = res.status === 429 || res.status === 503 ? serverRequestedDelay(res.headers) : undefined
      if (requested === undefined || requested <= config.maxRetryAfter) {
        const delay = requested ?? computeBackoff(attempt, config.initialRetryDelay, config.maxRetryDelay)
        logger.debug(
          `retrying ${method} ${pathForLog} in ${delay}ms (attempt ${attempt + 2} of ${maxRetries + 1}) after ${res.status}${typeof code === 'string' ? ` ${code}` : ''}`,
        )
        await sleep(delay, userSignal)
        continue
      }
      logger.debug(`not retrying: server asked to wait ${requested}ms, over maxRetryAfter`)
    }
    throw makeAPIError({ status: res.status, body: parsed, headers: res.headers, requiredScope: spec.requiredScope })
  }
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: { code?: string; message?: string } }).cause
    return cause?.code ? `${err.message} (${cause.code})` : err.message
  }
  return String(err)
}
