import {
  APIConnectionError,
  APIError,
  AuthenticationError,
  InvoiceAIError,
  PermissionError,
  RateLimitError,
} from '@horizonpay/invoice-ai'
import type { Colors } from './util/colors'

/**
 * Exit codes. Scripts branch on these, so they never change meaning.
 *
 *   0 ok · 1 API or runtime error · 2 usage error · 3 auth · 4 rate limited
 */
export const ExitCode = {
  OK: 0,
  API: 1,
  USAGE: 2,
  AUTH: 3,
  RATE_LIMITED: 4,
} as const
export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode]

/** An error the CLI raises itself, with the exit code it should end with. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: ExitCode = ExitCode.API,
    readonly hint?: string,
  ) {
    super(message)
    this.name = 'CliError'
  }
}

export const usageError = (message: string, hint?: string) => new CliError(message, ExitCode.USAGE, hint)
export const authError = (message: string, hint?: string) => new CliError(message, ExitCode.AUTH, hint)

/** The exit code for anything a command threw. */
export function exitCodeFor(err: unknown): ExitCode {
  if (err instanceof CliError) return err.exitCode
  if (err instanceof AuthenticationError || err instanceof PermissionError) return ExitCode.AUTH
  if (err instanceof RateLimitError) return ExitCode.RATE_LIMITED
  if (err instanceof APIError) return ExitCode.API
  return ExitCode.API
}

/**
 * Human-readable error block for stderr:
 *
 *   Error: invalid_state (409)
 *     Only draft invoices can be deleted.
 *     request_id: req_123
 */
export function formatError(err: unknown, c: Colors): string {
  const lines: string[] = []
  if (err instanceof APIError) {
    const code = err.code ?? `http_${err.status}`
    lines.push(`${c.red(c.bold('Error:'))} ${code} ${c.dim(`(${err.status})`)}`)
    const detail = err.detail ?? err.title
    if (detail) lines.push(`  ${detail}`)
    for (const f of err.fields) lines.push(`  ${c.yellow(f.path || '(body)')}: ${f.message}`)
    if (err instanceof PermissionError && err.requiredScope) {
      lines.push(`  missing scope: ${err.requiredScope}`)
    }
    if (err instanceof RateLimitError && err.retryAfter !== undefined) {
      lines.push(`  retry after: ${err.retryAfter}s`)
    }
    if (err.requestId) lines.push(c.dim(`  request_id: ${err.requestId}`))
    const hint = hintFor(err)
    if (hint) lines.push(c.dim(`  ${hint}`))
    return lines.join('\n')
  }
  if (err instanceof CliError) {
    lines.push(`${c.red(c.bold('Error:'))} ${err.message}`)
    if (err.hint) lines.push(c.dim(`  ${err.hint}`))
    return lines.join('\n')
  }
  if (err instanceof APIConnectionError) {
    const cause = err.cause instanceof Error ? ` (${err.cause.message})` : ''
    return `${c.red(c.bold('Error:'))} ${err.message}${cause}\n${c.dim('  Check your connection, or INVOICE_AI_BASE_URL if you set it.')}`
  }
  if (err instanceof InvoiceAIError || err instanceof Error) {
    return `${c.red(c.bold('Error:'))} ${err.message}`
  }
  return `${c.red(c.bold('Error:'))} ${String(err)}`
}

function hintFor(err: APIError): string | undefined {
  if (err instanceof AuthenticationError) {
    return 'Run `invoice-ai login`, or check the key in --api-key / INVOICE_AI_API_KEY.'
  }
  if (err instanceof PermissionError) {
    return 'Create a key with that scope, or run `invoice-ai login` again and keep it ticked.'
  }
  return undefined
}
