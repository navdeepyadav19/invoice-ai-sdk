import { APIPromise } from './api-promise'
import { InvoiceAIError } from './errors'
import { executeRequest, type ClientConfig, type HttpMethod, type RequestOptions, type RequestSpec } from './http'
import { makeLogger, type LogLevel, type Logger } from './logger'
import { PagePromise } from './pagination'
import { readEnv } from './runtime'

export const DEFAULT_BASE_URL = 'https://invoice.horizonpay.co/api/v1'

export interface ClientOptions {
  /** Defaults to the `INVOICE_AI_API_KEY` environment variable. */
  apiKey?: string
  /** Defaults to `INVOICE_AI_BASE_URL`, then the production API. */
  baseURL?: string
  /** Milliseconds per attempt. Default 60000. */
  timeout?: number
  /** Automatic retries per call. Default 2. */
  maxRetries?: number
  /** A custom fetch (for proxies, tests or older runtimes). Default: global fetch. */
  fetch?: typeof fetch
  /** `debug` logs every request and retry decision (secrets redacted). Default `warn`, or `INVOICE_AI_LOG`. */
  logLevel?: LogLevel
  /** Where log lines go. Default: console. */
  logger?: Logger
  /** Headers added to every request. */
  defaultHeaders?: Record<string, string>
  /** First retry delay in ms. Default 500. */
  initialRetryDelay?: number
  /** Backoff cap in ms. Default 8000. */
  maxRetryDelay?: number
  /** Longest `Retry-After` we'll wait through automatically, in ms. Default 60000. */
  maxRetryAfter?: number
}

/** Options for the `request()` escape hatch. */
export interface RawRequestOptions extends RequestOptions {
  query?: Record<string, unknown>
  body?: unknown
}

/**
 * The transport every resource shares. `InvoiceAI` extends this with the
 * generated resources (`invoiceai.customers`, `invoiceai.invoices`, …).
 */
export class BaseClient {
  /** Resolved configuration. The API key is not enumerable, so it won't show in logs or JSON. */
  declare protected readonly config: ClientConfig

  constructor(options: ClientOptions = {}) {
    const apiKey = options.apiKey ?? readEnv('INVOICE_AI_API_KEY')
    if (!apiKey) {
      throw new InvoiceAIError(
        'Missing API key. Pass `new InvoiceAI({ apiKey })` or set INVOICE_AI_API_KEY. Create one under Settings → API keys.',
      )
    }
    if (!/^inv_[a-z]+_\S+$/.test(apiKey)) {
      throw new InvoiceAIError('That does not look like an Invoice-AI API key: keys start with `inv_live_`.')
    }
    const fetchImpl = options.fetch ?? (globalThis as { fetch?: typeof fetch }).fetch
    if (typeof fetchImpl !== 'function') {
      throw new InvoiceAIError('No global fetch found. Use Node 18+ or pass `fetch` in the client options.')
    }
    const config: ClientConfig = {
      apiKey,
      baseURL: options.baseURL ?? readEnv('INVOICE_AI_BASE_URL') ?? DEFAULT_BASE_URL,
      timeout: options.timeout ?? 60_000,
      maxRetries: options.maxRetries ?? 2,
      fetch: options.fetch ?? ((input, init) => fetchImpl(input, init)),
      logger: makeLogger(options.logLevel, options.logger),
      defaultHeaders: options.defaultHeaders ?? {},
      initialRetryDelay: options.initialRetryDelay ?? 500,
      maxRetryDelay: options.maxRetryDelay ?? 8000,
      maxRetryAfter: options.maxRetryAfter ?? 60_000,
    }
    Object.defineProperty(this, 'config', { value: config, enumerable: false })
  }

  get baseURL(): string {
    return this.config.baseURL
  }

  /**
   * Escape hatch for endpoints the SDK doesn't wrap yet. Returns the parsed
   * response body as-is (not unwrapped from `data`), with the same retries,
   * idempotency, errors and logging as every other call.
   *
   *   const { data } = await invoiceai.request<{ data: Business }>('GET', '/business')
   */
  request<T = unknown>(method: HttpMethod, path: string, options: RawRequestOptions = {}): APIPromise<T> {
    const { query, body, ...rest } = options
    return this._request<T>({ method, path, query, body, options: rest }, 'body')
  }

  /** @internal Used by generated resources. */
  _request<T>(spec: RequestSpec, shape: 'data' | 'body' | 'void' | 'binary'): APIPromise<T> {
    const responseType = shape === 'binary' ? 'binary' : 'json'
    const pending = executeRequest(this.config, { ...spec, responseType })
    return new APIPromise<T>(pending, (res) => {
      if (shape === 'void') return undefined as T
      if (shape === 'data') {
        const body = res.body as { data?: unknown } | undefined
        return (body && typeof body === 'object' && 'data' in body ? body.data : body) as T
      }
      return res.body as T
    })
  }

  /** @internal Used by generated list methods. */
  _requestPage<Item>(spec: RequestSpec): PagePromise<Item> {
    const pending = executeRequest(this.config, spec)
    const pageOptions: RequestOptions = { ...spec.options, idempotencyKey: undefined }
    return new PagePromise<Item>(pending, (cursor) =>
      this._requestPage<Item>({ ...spec, query: { ...spec.query, cursor }, options: pageOptions }),
    )
  }
}

/** @internal Encodes one path parameter, refusing empty values (`/customers/undefined`). */
export function pathParam(name: string, value: unknown): string {
  if (typeof value !== 'string' || value === '') {
    throw new InvoiceAIError(`\`${name}\` must be a non-empty string, got ${value === '' ? 'an empty string' : typeof value}`)
  }
  return encodeURIComponent(value)
}

/** @internal Splits one params object into query and body parts. */
export function splitParams(
  params: object | undefined,
  queryKeys: readonly string[],
): { query: Record<string, unknown> | undefined; body: Record<string, unknown> | undefined } {
  if (!params) return { query: undefined, body: undefined }
  const query: Record<string, unknown> = {}
  const body: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(params)) {
    if (queryKeys.includes(k)) query[k] = v
    else body[k] = v
  }
  return { query, body }
}

/** @internal Base class of generated resources. */
export class APIResource {
  constructor(protected readonly _client: BaseClient) {}
}
