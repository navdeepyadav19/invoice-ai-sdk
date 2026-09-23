import { Command, Option } from 'commander'
import { registerApi } from './commands/api'
import { registerAuth } from './commands/auth'
import { registerCompletion } from './commands/completion'
import { registerCustomers } from './commands/customers'
import { registerInvoiceItems } from './commands/invoice-items'
import { registerInvoices } from './commands/invoices'
import { registerOpen } from './commands/open'
import { registerPrices } from './commands/prices'
import { registerProducts } from './commands/products'
import type { Act } from './commands/shared'
import { registerWebhooks } from './commands/webhooks'
import { CLI_VERSION } from './constants'
import { Ctx } from './context'
import type { Deps } from './deps'

/**
 * The command tree. Built fresh per run so tests (and the docs generator)
 * can create it in-process with fake dependencies.
 */
export function buildProgram(deps: Deps): Command {
  const program = new Command('invoice-ai')

  // Set before any subcommand exists: commander copies these settings into
  // every `.command()` created afterwards.
  program
    .exitOverride()
    .configureOutput({
      writeOut: (s) => deps.stdout.write(s),
      writeErr: (s) => deps.stderr.write(s),
      getOutHelpWidth: () => deps.stdout.columns ?? 80,
      getErrHelpWidth: () => deps.stderr.columns ?? 80,
      // Usage errors are printed by run() with the hint, not by commander.
      outputError: () => undefined,
    })
    .showSuggestionAfterError(true)
    .configureHelp({ sortSubcommands: false, showGlobalOptions: true })

  program
    .description('Invoice-AI from your terminal. Log in once, then manage customers, products, prices, invoices, invoice items and webhooks.')
    .version(CLI_VERSION, '-v, --version', 'print the CLI version')
    .helpOption('-h, --help', 'show help')
    .option('--api-key <key>', 'API key to use (overrides INVOICE_AI_API_KEY and the saved profile)')
    .option('-p, --profile <name>', 'saved profile to use (see `invoice-ai switch`)')
    .option('--json', 'print raw JSON (default when output is piped)')
    .addOption(new Option('--format <format>', 'output format').choices(['table', 'json', 'csv']))
    .option('-y, --yes', 'skip confirmation prompts')
    .option('--debug', 'log each API request and retry (secrets redacted)')
    .option('--no-color', 'disable colors (also honours NO_COLOR)')
    .addHelpText(
      'after',
      `
Examples:
  $ invoice-ai login
  $ invoice-ai invoices create
  $ invoice-ai invoices list --status open
  $ invoice-ai customers create --name "Acme" --email ap@acme.com
  $ invoice-ai api GET /business

Environment:
  INVOICE_AI_API_KEY      API key (for CI); beats the saved profile
  INVOICE_AI_PROFILE      profile to use when --profile isn't given
  INVOICE_AI_BASE_URL     API base URL, e.g. http://localhost:3000/api/v1
  INVOICE_AI_NO_KEYCHAIN  keep keys in the config file, not the OS keychain
  NO_COLOR                disable colors

Exit codes: 0 ok · 1 API error · 2 usage error · 3 auth · 4 rate limited`,
    )

  const act: Act = (handler) => async (...all: unknown[]) => {
    const cmd = all[all.length - 1] as Command
    const opts = all[all.length - 2] as never
    const args = all.slice(0, -2).map((a) => a as string)
    await handler(new Ctx(deps, cmd), args, opts)
  }

  registerAuth(program, act)
  registerCustomers(program, act)
  registerProducts(program, act)
  registerPrices(program, act)
  registerInvoices(program, act)
  registerInvoiceItems(program, act)
  registerWebhooks(program, act)
  registerApi(program, act)
  registerOpen(program, act)
  registerCompletion(program, act)

  // `invoice-ai customers --help` already works; a `help` subcommand in every
  // group is noise.
  const noHelpCommand = (cmd: Command) => {
    cmd.helpCommand(false)
    cmd.commands.forEach(noHelpCommand)
  }
  noHelpCommand(program)

  return program
}
