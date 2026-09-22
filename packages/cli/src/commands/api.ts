import type { Command } from 'commander'
import type { HttpMethod } from '@horizonpay/invoice-ai'
import { usageError } from '../errors'
import { collect, parseQueryPairs, readDataArg } from '../util/parse'
import type { Act } from './shared'

const METHODS = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'] as const

/**
 * `invoice-ai api GET /business` — the escape hatch, like `gh api`. Goes
 * through the SDK's `request()`, so auth, retries, idempotency keys and error
 * handling are the same as every other command.
 */
export function registerApi(program: Command, act: Act): void {
  program
    .command('api <method> <path>')
    .description('Call any API endpoint directly and print the JSON response')
    .option('-d, --data <json>', 'request body as JSON, @file.json or @- for stdin')
    .option('-q, --query <key=value>', 'query parameter (repeatable)', collect)
    .option('--idempotency-key <key>', 'Idempotency-Key for POST (default: generated)')
    .addHelpText(
      'after',
      '\nThe path is relative to /api/v1 (a leading /api/v1 is accepted too).\n\nExamples:\n  $ invoice-ai api GET /business\n  $ invoice-ai api GET /invoices --query status=open --query limit=5\n  $ invoice-ai api POST /customers --data \'{"name":"Acme","email":"ap@acme.com"}\'\n  $ invoice-ai api PATCH /customers/cus_123 --data @patch.json',
    )
    .action(
      act<{ data?: string; query?: string[]; idempotencyKey?: string }>(async (ctx, [method, path], opts) => {
        const m = method!.toUpperCase()
        if (!(METHODS as readonly string[]).includes(m)) throw usageError(`Unsupported method "${method}".`, `Use one of ${METHODS.join(', ')}.`)
        let p = path!.startsWith('/') ? path! : `/${path}`
        p = p.replace(/^\/api\/v1(?=\/|$)/, '') || '/'
        const body = opts.data !== undefined ? await readDataArg(opts.data, ctx.deps.readStdin) : undefined
        const client = await ctx.client()
        const result = await client.request(m as HttpMethod, p, {
          ...(opts.query?.length ? { query: parseQueryPairs(opts.query) } : {}),
          ...(body !== undefined ? { body } : {}),
          ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
        })
        if (result !== undefined && result !== null && result !== '') ctx.out(JSON.stringify(result, null, 2))
      }),
    )
}
