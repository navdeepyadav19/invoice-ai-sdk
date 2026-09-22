import { readEnv } from './runtime'

/**
 * Debug logging with secrets redacted.
 *
 * Turn it on with `new InvoiceAI({ logLevel: 'debug' })` or
 * `INVOICE_AI_LOG=debug`. It prints method, path, status, request id and each
 * retry decision. The API key never appears: it's shortened to
 * `inv_live_ab12cd34…`, and webhook secrets to `whsec_…`.
 */

export type LogLevel = 'off' | 'error' | 'warn' | 'info' | 'debug'

export interface Logger {
  error(message: string, ...rest: unknown[]): void
  warn(message: string, ...rest: unknown[]): void
  info(message: string, ...rest: unknown[]): void
  debug(message: string, ...rest: unknown[]): void
}

const ORDER: Record<LogLevel, number> = { off: 0, error: 1, warn: 2, info: 3, debug: 4 }

export function parseLogLevel(value: string | undefined): LogLevel | undefined {
  const v = value?.toLowerCase()
  return v && v in ORDER ? (v as LogLevel) : undefined
}

/** A logger that drops anything below `level` and redacts what it keeps. */
export function makeLogger(level: LogLevel | undefined, sink: Logger = console): Logger {
  const effective = level ?? parseLogLevel(readEnv('INVOICE_AI_LOG')) ?? 'warn'
  const at = (l: Exclude<LogLevel, 'off'>) => (message: string, ...rest: unknown[]) => {
    if (ORDER[effective] < ORDER[l]) return
    sink[l](`[invoice-ai] ${redactSecrets(message)}`, ...rest.map(redactValue))
  }
  return { error: at('error'), warn: at('warn'), info: at('info'), debug: at('debug') }
}

/** `inv_live_ab12cd34_secret…` → `inv_live_ab12cd34…`. Unknown shapes keep 4 chars. */
export function redactApiKey(key: string): string {
  const m = key.match(/^(inv_[a-z]+_[A-Za-z0-9]{1,8})/)
  if (m) return `${m[1]}…`
  return key.length <= 4 ? '…' : `${key.slice(0, 4)}…`
}

const SECRET_PATTERNS: [RegExp, (m: string) => string][] = [
  [/inv_[a-z]+_[A-Za-z0-9]+_[A-Za-z0-9_-]+/g, redactApiKey],
  [/whsec_[A-Za-z0-9+/=_-]+/g, () => 'whsec_…'],
]

/** Redacts API keys and webhook secrets anywhere in a string. */
export function redactSecrets(text: string): string {
  let out = text
  for (const [re, fn] of SECRET_PATTERNS) out = out.replace(re, fn)
  return out
}

const SENSITIVE_HEADERS = new Set(['authorization', 'cookie', 'set-cookie', 'x-api-key'])

/** A plain-object copy of headers that is safe to print. */
export function redactHeaders(headers: Headers | Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  const entries = headers instanceof Headers ? Array.from(headers.entries()) : Object.entries(headers)
  for (const [name, value] of entries) {
    const lower = name.toLowerCase()
    if (lower === 'authorization') {
      const token = value.replace(/^Bearer\s+/i, '')
      out[lower] = `Bearer ${redactApiKey(token)}`
    } else if (SENSITIVE_HEADERS.has(lower)) {
      out[lower] = '[redacted]'
    } else {
      out[lower] = redactSecrets(value)
    }
  }
  return out
}

function redactValue(value: unknown): unknown {
  if (typeof value === 'string') return redactSecrets(value)
  if (value instanceof Headers) return redactHeaders(value)
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      out[k] = k.toLowerCase() === 'headers' && v && typeof v === 'object'
        ? redactHeaders(v as Record<string, string>)
        : redactValue(v)
    }
    return out
  }
  return value
}
