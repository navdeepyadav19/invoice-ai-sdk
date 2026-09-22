import type { Command } from 'commander'
import { InvoiceAI, type Logger } from '@horizonpay/invoice-ai'
import { configDir } from './auth/config'
import { resolveCredentials, siteUrl, type ResolvedCredentials } from './auth/credentials'
import { osKeychain, type SecretStore } from './auth/keychain'
import type { Deps } from './deps'
import { CliError, ExitCode, usageError } from './errors'
import { renderCsv, renderJson, renderObject, renderTable, resolveFormat, type Column, type OutputFormat } from './output/format'
import { colorsEnabled, makeColors, type Colors } from './util/colors'
import { makeSpinner, type Spinner } from './util/spinner'

/** Options every command accepts (defined on the root program). */
export interface GlobalOptions {
  apiKey?: string
  profile?: string
  json?: boolean
  format?: string
  yes?: boolean
  debug?: boolean
  color?: boolean
}

/**
 * What a command action works with: parsed global options, output helpers,
 * an SDK client on demand, and the prompts/confirmation policy.
 */
export class Ctx {
  readonly globals: GlobalOptions
  readonly c: Colors
  /** Colours for stderr (it can be a TTY while stdout is piped). */
  readonly ce: Colors
  readonly format: OutputFormat
  /** True when we may prompt: stdin and stdout are terminals and this isn't CI. */
  readonly interactive: boolean
  readonly configDir: string
  readonly secrets: SecretStore
  private clientPromise: Promise<{ client: InvoiceAI; creds: ResolvedCredentials }> | undefined

  constructor(
    readonly deps: Deps,
    cmd: Command,
  ) {
    this.globals = cmd.optsWithGlobals() as GlobalOptions
    const colorFlag = this.globals.color !== false
    this.c = makeColors(colorsEnabled(deps.env, Boolean(deps.stdout.isTTY), colorFlag))
    this.ce = makeColors(colorsEnabled(deps.env, Boolean(deps.stderr.isTTY), colorFlag))
    this.format = resolveFormat(this.globals, Boolean(deps.stdout.isTTY))
    this.interactive = deps.stdinIsTTY && Boolean(deps.stdout.isTTY) && !isCI(deps.env)
    this.configDir = configDir(deps.env)
    this.secrets = deps.secretStore ?? osKeychain(deps.env, deps.platform)
  }

  get env() {
    return this.deps.env
  }

  /** JSON was asked for (--json / --format json), not just inferred from a pipe. */
  get explicitJson(): boolean {
    return Boolean(this.globals.json) || this.globals.format === 'json'
  }

  // ---------------------------------------------------------------- output

  out(text: string): void {
    this.deps.stdout.write(text.endsWith('\n') ? text : `${text}\n`)
  }

  /** Status lines go to stderr so `--json` output on stdout stays parseable. */
  info(text: string): void {
    this.deps.stderr.write(text.endsWith('\n') ? text : `${text}\n`)
  }

  success(text: string): void {
    this.info(`${this.ce.green('✔')} ${text}`)
  }

  warn(text: string): void {
    this.info(`${this.ce.yellow('!')} ${text}`)
  }

  /** Prints one API object: key/value table, JSON, or a one-row CSV. */
  printObject<T extends object>(obj: T, opts: { columns?: Column<T>[]; summary?: (o: T) => Record<string, unknown> } = {}): void {
    if (this.format === 'json') return this.out(renderJson(obj))
    if (this.format === 'csv') {
      const columns = opts.columns ?? (Object.keys(obj).map((k) => ({ header: k, value: (r: T) => (r as Record<string, unknown>)[k] })) as Column<T>[])
      return this.out(renderCsv([obj], columns))
    }
    this.out(renderObject(opts.summary ? opts.summary(obj) : (obj as Record<string, unknown>), this.c))
  }

  /** Prints a list page (`{ data, next_cursor }` as JSON). */
  printList<T>(rows: readonly T[], columns: Column<T>[], nextCursor: string | null = null): void {
    if (this.format === 'json') return this.out(renderJson({ data: rows, next_cursor: nextCursor }))
    if (this.format === 'csv') return this.out(renderCsv(rows, columns))
    if (rows.length === 0) {
      this.info(this.ce.dim('No results.'))
      return
    }
    this.out(renderTable(rows, columns, this.c))
    if (nextCursor) this.info(this.ce.dim(`More results: add --all, or --cursor ${nextCursor}`))
  }

  spinner(): Spinner {
    return makeSpinner(this.deps.stderr, Boolean(this.deps.stderr.isTTY) && !isCI(this.deps.env))
  }

  // ---------------------------------------------------------------- client

  /** The SDK client, built once per command from the resolved credentials. */
  async client(): Promise<InvoiceAI> {
    return (await this.clientWithCreds()).client
  }

  async clientWithCreds(): Promise<{ client: InvoiceAI; creds: ResolvedCredentials }> {
    this.clientPromise ??= (async () => {
      const creds = await resolveCredentials({
        flagKey: this.globals.apiKey,
        flagProfile: this.globals.profile,
        env: this.deps.env,
        configDir: this.configDir,
        secrets: this.secrets,
      })
      const retries = Number(this.deps.env.INVOICE_AI_MAX_RETRIES)
      const client = new InvoiceAI({
        apiKey: creds.apiKey,
        ...(creds.baseURL ? { baseURL: creds.baseURL } : {}),
        ...(this.deps.env.INVOICE_AI_MAX_RETRIES && Number.isInteger(retries) && retries >= 0 ? { maxRetries: retries } : {}),
        fetch: this.deps.fetch,
        ...(this.globals.debug ? { logLevel: 'debug' as const, logger: this.stderrLogger() } : { logLevel: 'error' as const, logger: this.stderrLogger() }),
      })
      return { client, creds }
    })()
    return this.clientPromise
  }

  /** Site root for device login, `open` and logout. */
  site(creds?: ResolvedCredentials): string {
    return siteUrl(this.deps.env.INVOICE_AI_BASE_URL || creds?.baseURL)
  }

  private stderrLogger(): Logger {
    const write = (level: string) => (message: string, ...rest: unknown[]) => {
      const extra = rest.length ? ` ${rest.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join(' ')}` : ''
      this.deps.stderr.write(`${this.ce.dim(`${level} ${message}${extra}`)}\n`)
    }
    return { error: write('error'), warn: write('warn'), info: write('info'), debug: write('debug') }
  }

  // ---------------------------------------------------------------- prompts

  /** Fails with exit 2 when a prompt is needed but we can't show one. */
  requireInteractive(what: string, hint: string): void {
    if (!this.interactive) throw usageError(`${what} needs an interactive terminal.`, hint)
  }

  /**
   * Asks before destructive actions. --yes skips; without a TTY we refuse
   * (exit 2) rather than guess.
   */
  async confirm(message: string): Promise<void> {
    if (this.globals.yes) return
    this.requireInteractive('Confirmation', 'Re-run with --yes to confirm.')
    const p = await import('@clack/prompts')
    const answer = await p.confirm({ message, initialValue: false })
    if (p.isCancel(answer) || !answer) throw new CliError('Aborted.', ExitCode.API)
  }
}

export function isCI(env: Record<string, string | undefined>): boolean {
  return Boolean(env.CI && env.CI !== 'false' && env.CI !== '0')
}
