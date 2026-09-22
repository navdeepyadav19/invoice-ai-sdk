import { CLI_VERSION } from '../constants'
import { CliError, ExitCode } from '../errors'

/**
 * The browser device flow (RFC 8628), client side.
 *
 *   POST {site}/api/cli/device  → a device_code for us, a user_code for the human
 *   POST {site}/api/cli/token   → polled every `interval` s until approved (once)
 *
 * These two endpoints live outside /api/v1 — they exist before there is a key
 * — so this is the only place the CLI speaks HTTP to Invoice-AI directly.
 * Everything else goes through the SDK.
 */

export interface DeviceAuthorization {
  device_code: string
  user_code: string
  verification_uri: string
  verification_uri_complete: string
  interval: number
  expires_in: number
}

export interface DeviceToken {
  api_key: string
  key_id: string
  scopes: string[]
  account: { email: string | null; business_name: string | null }
}

export type DeviceErrorCode =
  | 'authorization_pending'
  | 'slow_down'
  | 'access_denied'
  | 'expired_token'
  | 'invalid_grant'
  | 'invalid_request'
  | 'rate_limited'
  | 'server_error'
  | 'network_error'

/** A terminal device-flow failure, with the message and exit code to end on. */
export class DeviceFlowError extends CliError {
  constructor(
    readonly code: DeviceErrorCode,
    message: string,
    exitCode: ExitCode,
    hint?: string,
  ) {
    super(message, exitCode, hint)
    this.name = 'DeviceFlowError'
  }
}

export interface FlowDeps {
  fetch: typeof fetch
  sleep(ms: number): Promise<void>
  now(): number
}

const HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json',
  'user-agent': `invoice-ai-cli/${CLI_VERSION}`,
}

interface OAuthErrorBody {
  error?: string
  error_description?: string
}

async function post(deps: FlowDeps, url: string, body: unknown): Promise<{ status: number; body: unknown; retryAfter?: number }> {
  let res: Response
  try {
    res = await deps.fetch(url, { method: 'POST', headers: HEADERS, body: JSON.stringify(body) })
  } catch (cause) {
    throw new DeviceFlowError(
      'network_error',
      `Could not reach ${new URL(url).origin}${cause instanceof Error ? ` (${cause.message})` : ''}.`,
      ExitCode.API,
      'Check your connection, or INVOICE_AI_BASE_URL if you set it.',
    )
  }
  const text = await res.text().catch(() => '')
  let parsed: unknown = undefined
  try {
    parsed = text ? JSON.parse(text) : undefined
  } catch {
    parsed = undefined
  }
  const ra = Number(res.headers.get('retry-after'))
  return { status: res.status, body: parsed, retryAfter: Number.isFinite(ra) && ra > 0 ? ra : undefined }
}

/** Step 1: ask the server for a code pair. */
export async function requestDeviceCode(
  deps: FlowDeps,
  site: string,
  client: { name: string; os: string },
): Promise<DeviceAuthorization> {
  const res = await post(deps, `${site}/api/cli/device`, { client_name: client.name, client_os: client.os })
  const body = (res.body ?? {}) as Partial<DeviceAuthorization> & OAuthErrorBody
  if (res.status === 200 && typeof body.device_code === 'string' && typeof body.user_code === 'string') {
    return {
      device_code: body.device_code,
      user_code: body.user_code,
      verification_uri: body.verification_uri ?? `${site}/cli/authorize`,
      verification_uri_complete:
        body.verification_uri_complete ?? `${site}/cli/authorize?code=${encodeURIComponent(body.user_code)}`,
      interval: typeof body.interval === 'number' && body.interval > 0 ? body.interval : 5,
      expires_in: typeof body.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : 600,
    }
  }
  if (res.status === 429 || body.error === 'rate_limited') {
    throw new DeviceFlowError(
      'rate_limited',
      'Too many login attempts from this network.',
      ExitCode.RATE_LIMITED,
      `Try again in ${res.retryAfter ?? 60}s.`,
    )
  }
  if (res.status === 404) {
    throw new DeviceFlowError(
      'server_error',
      `${site} doesn't support CLI login (404 on /api/cli/device).`,
      ExitCode.API,
      'Check INVOICE_AI_BASE_URL, or pass an API key with --api-key.',
    )
  }
  throw new DeviceFlowError(
    body.error === 'invalid_request' ? 'invalid_request' : 'server_error',
    body.error_description ?? `Could not start login (HTTP ${res.status}).`,
    ExitCode.API,
  )
}

/** Poll-loop state, reported after every poll (drives the spinner; tests assert on it). */
export interface PollEvent {
  outcome: 'authorization_pending' | 'slow_down' | 'retry'
  interval: number
}

export interface PollOptions {
  site: string
  deviceCode: string
  interval: number
  expiresIn: number
  onPoll?: (event: PollEvent) => void
  /** Consecutive transient failures (5xx, network) tolerated before giving up. */
  maxTransientFailures?: number
}

/**
 * Step 2: poll until the user approves or denies, or the code expires.
 *
 *   authorization_pending → wait `interval`, poll again
 *   slow_down             → interval += 5s (RFC 8628 §3.5), poll again
 *   429 / 5xx / network   → back off and retry a few times
 *   access_denied         → exit 3
 *   expired_token         → exit 3 (also when our own clock runs out)
 *   invalid_grant         → exit 3 (the code was already used or never existed)
 *   200                   → the key, exactly once
 */
export async function pollForToken(deps: FlowDeps, opts: PollOptions): Promise<DeviceToken> {
  let interval = Math.max(1, opts.interval)
  const deadline = deps.now() + opts.expiresIn * 1000
  const maxTransient = opts.maxTransientFailures ?? 3
  let transient = 0

  for (;;) {
    await deps.sleep(interval * 1000)
    if (deps.now() >= deadline) throw expired()

    let res: Awaited<ReturnType<typeof post>>
    try {
      res = await post(deps, `${opts.site}/api/cli/token`, { device_code: opts.deviceCode })
    } catch (err) {
      if (err instanceof DeviceFlowError && err.code === 'network_error' && ++transient <= maxTransient) {
        opts.onPoll?.({ outcome: 'retry', interval })
        continue
      }
      throw err
    }

    const body = (res.body ?? {}) as Partial<DeviceToken> & OAuthErrorBody
    if (res.status === 200 && typeof body.api_key === 'string') {
      return {
        api_key: body.api_key,
        key_id: body.key_id ?? '',
        scopes: Array.isArray(body.scopes) ? body.scopes : [],
        account: body.account ?? { email: null, business_name: null },
      }
    }

    switch (body.error) {
      case 'authorization_pending':
        transient = 0
        opts.onPoll?.({ outcome: 'authorization_pending', interval })
        continue
      case 'slow_down':
        transient = 0
        interval += 5
        opts.onPoll?.({ outcome: 'slow_down', interval })
        continue
      case 'access_denied':
        throw new DeviceFlowError(
          'access_denied',
          'Login was denied in the browser.',
          ExitCode.AUTH,
          'Run `invoice-ai login` to try again.',
        )
      case 'expired_token':
        throw expired()
      case 'invalid_grant':
        throw new DeviceFlowError(
          'invalid_grant',
          'This login code is no longer valid (it was already used, or never existed).',
          ExitCode.AUTH,
          'Run `invoice-ai login` to start again.',
        )
      case 'invalid_request':
        throw new DeviceFlowError('invalid_request', body.error_description ?? 'The server rejected the login request.', ExitCode.API)
    }

    // 429 or 5xx: transient. Wait what the server asks (or one interval) and retry.
    if ((res.status === 429 || res.status >= 500) && ++transient <= maxTransient) {
      opts.onPoll?.({ outcome: 'retry', interval })
      if (res.retryAfter && res.retryAfter > interval) await deps.sleep((res.retryAfter - interval) * 1000)
      continue
    }
    if (res.status === 429) {
      throw new DeviceFlowError('rate_limited', 'Rate limited while waiting for login.', ExitCode.RATE_LIMITED, 'Wait a minute, then run `invoice-ai login` again.')
    }
    throw new DeviceFlowError(
      'server_error',
      body.error_description ?? `Login failed on the server (HTTP ${res.status}).`,
      ExitCode.API,
      'Run `invoice-ai login` to try again.',
    )
  }
}

function expired(): DeviceFlowError {
  return new DeviceFlowError(
    'expired_token',
    'The login code expired before it was approved.',
    ExitCode.AUTH,
    'Run `invoice-ai login` again and approve within 10 minutes.',
  )
}

/** DELETE {site}/api/cli/session — revokes the key it's called with. 401 means already revoked. */
export async function revokeSession(
  deps: Pick<FlowDeps, 'fetch'>,
  site: string,
  apiKey: string,
): Promise<'revoked' | 'already_revoked' | { failed: string }> {
  try {
    const res = await deps.fetch(`${site}/api/cli/session`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${apiKey}`, 'user-agent': HEADERS['user-agent'] },
    })
    if (res.status === 204 || res.status === 200) return 'revoked'
    if (res.status === 401) return 'already_revoked'
    return { failed: `HTTP ${res.status}` }
  } catch (cause) {
    return { failed: cause instanceof Error ? cause.message : String(cause) }
  }
}
