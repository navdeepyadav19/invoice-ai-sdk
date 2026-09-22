/**
 * Errors you can branch on.
 *
 *   try { await invoiceai.invoices.void(id) }
 *   catch (e) { if (e instanceof InvalidStateError) … }
 *
 * Every API error keeps the server's RFC 9457 problem fields (`code`,
 * `detail`, `type`, `status`), the request id and the raw body. The message
 * always ends with "(request req_…)" so a pasted stack trace is enough for
 * support to find the request.
 */

/** One field-level problem from a 422. */
export interface FieldError {
  path: string
  message: string
}

/** The RFC 9457 body the API returns for every error. */
export interface ProblemBody {
  type?: string
  title?: string
  status?: number
  detail?: string
  instance?: string
  code?: string
  errors?: FieldError[]
  [key: string]: unknown
}

/** Base class of everything this SDK throws. */
export class InvoiceAIError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = new.target.name
  }
}

export interface APIErrorInit {
  status: number
  body: unknown
  headers: Headers
  /** Scope the operation needs, from the spec's `x-required-scope`. */
  requiredScope?: string
}

/** Any non-2xx response from the API. */
export class APIError extends InvoiceAIError {
  /** HTTP status, e.g. 409. */
  readonly status: number
  /** Stable machine-readable code, e.g. `invalid_state`. Branch on this. */
  readonly code: string | undefined
  /** Human-readable explanation. Wording may change; don't parse it. */
  readonly detail: string | undefined
  /** Problem type URL. */
  readonly type: string | undefined
  readonly title: string | undefined
  /** `X-Request-Id` (or the problem's `instance`). Quote it to support. */
  readonly requestId: string | undefined
  /** Field-level problems (422). Empty when there are none. */
  readonly fields: FieldError[]
  readonly headers: Headers
  /** The parsed response body, untouched. */
  readonly body: unknown

  constructor(init: APIErrorInit) {
    const problem = asProblem(init.body)
    const requestId = init.headers.get('x-request-id') ?? problem.instance ?? undefined
    super(formatMessage(init.status, problem, requestId))
    this.status = init.status
    this.code = problem.code
    this.detail = problem.detail
    this.type = problem.type
    this.title = problem.title
    this.requestId = requestId
    this.fields = Array.isArray(problem.errors) ? problem.errors : []
    this.headers = init.headers
    this.body = init.body
  }
}

/** 401 `unauthorized`: missing, malformed, unknown, revoked or expired key. */
export class AuthenticationError extends APIError {}

/** 403 `forbidden`: the key is valid but lacks the scope this operation needs. */
export class PermissionError extends APIError {
  /** The scope that was missing, when known (e.g. `invoices:write`). */
  readonly requiredScope: string | undefined
  constructor(init: APIErrorInit) {
    super(init)
    this.requiredScope = scopeFromDetail(this.detail) ?? init.requiredScope
  }
}

/** 404 `not_found`: no such resource, or it belongs to another account. */
export class NotFoundError extends APIError {}

/** 409 `invalid_state`: the resource is in the wrong state; retrying won't help. */
export class InvalidStateError extends APIError {}

/** 409 `conflict`: clashed with a concurrent request; retrying later may work. */
export class ConflictError extends APIError {}

/** 422 `validation`: see `.fields` for each field that failed. */
export class ValidationError extends APIError {}

/** 422 `idempotency_mismatch`: an `Idempotency-Key` was reused with a different request. */
export class IdempotencyError extends APIError {}

/** 428 `idempotency_key_required`: the endpoint needs an `Idempotency-Key`. */
export class IdempotencyKeyRequiredError extends IdempotencyError {}

/** 429 `rate_limited`. */
export class RateLimitError extends APIError {
  /** Seconds the server asked us to wait (`Retry-After`), if sent. */
  readonly retryAfter: number | undefined
  constructor(init: APIErrorInit) {
    super(init)
    const raw = init.headers.get('retry-after')
    const n = raw === null ? NaN : Number(raw)
    this.retryAfter = Number.isFinite(n) ? n : undefined
  }
}

/** 500 `internal_error`. */
export class InternalServerError extends APIError {}

/** 502 `upstream_failed`: a provider we depend on (email, database) failed. */
export class UpstreamError extends APIError {}

/** The request never produced an HTTP response (DNS, TLS, reset, offline…). */
export class APIConnectionError extends InvoiceAIError {
  constructor(message = 'Connection error.', options?: { cause?: unknown }) {
    super(message, options)
  }
}

/** The request took longer than `timeout`. */
export class APITimeoutError extends APIConnectionError {
  constructor(message = 'Request timed out.', options?: { cause?: unknown }) {
    super(message, options)
  }
}

/** The caller aborted the request through its `signal`. */
export class APIUserAbortError extends InvoiceAIError {
  constructor(message = 'Request was aborted.', options?: { cause?: unknown }) {
    super(message, options)
  }
}

/** A webhook failed signature, timestamp or payload checks. */
export class WebhookVerificationError extends InvoiceAIError {}

type APIErrorClass = new (init: APIErrorInit) => APIError

/** Server `code` → class. Every code the API documents has an entry. */
export const ERROR_CLASS_BY_CODE: Readonly<Record<string, APIErrorClass>> = {
  unauthorized: AuthenticationError,
  forbidden: PermissionError,
  not_found: NotFoundError,
  invalid_state: InvalidStateError,
  conflict: ConflictError,
  validation: ValidationError,
  idempotency_mismatch: IdempotencyError,
  idempotency_key_required: IdempotencyKeyRequiredError,
  rate_limited: RateLimitError,
  internal_error: InternalServerError,
  upstream_failed: UpstreamError,
}

/** Fallback when the body has no known `code` (e.g. a proxy's HTML 502). */
function classForStatus(status: number): APIErrorClass {
  if (status === 401) return AuthenticationError
  if (status === 403) return PermissionError
  if (status === 404) return NotFoundError
  if (status === 422) return ValidationError
  if (status === 428) return IdempotencyKeyRequiredError
  if (status === 429) return RateLimitError
  if (status === 502 || status === 503 || status === 504) return UpstreamError
  if (status >= 500) return InternalServerError
  return APIError
}

/** Builds the most specific error for a response. */
export function makeAPIError(init: APIErrorInit): APIError {
  const code = asProblem(init.body).code
  const Cls = (code && ERROR_CLASS_BY_CODE[code]) || classForStatus(init.status)
  return new Cls(init)
}

function asProblem(body: unknown): ProblemBody {
  return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as ProblemBody) : {}
}

function formatMessage(status: number, problem: ProblemBody, requestId: string | undefined): string {
  const code = problem.code ?? `http_${status}`
  let text = problem.detail ?? problem.title ?? `Request failed with status ${status}`
  if (Array.isArray(problem.errors) && problem.errors.length > 0) {
    const fields = problem.errors
      .slice(0, 5)
      .map((e) => `${e.path || '(body)'}: ${e.message}`)
      .join('; ')
    text += ` [${fields}${problem.errors.length > 5 ? '; …' : ''}]`
  }
  return `${status} ${code}: ${text}${requestId ? ` (request ${requestId})` : ''}`
}

function scopeFromDetail(detail: string | undefined): string | undefined {
  return detail?.match(/\b([a-z_]+:[a-z_]+)\b/)?.[1]
}
