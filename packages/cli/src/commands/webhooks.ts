import { randomUUID } from 'node:crypto'
import type { Command } from 'commander'
import { Webhooks, type Invoice, type WebhookEndpointCreateParams, type WebhookEventType } from '@horizonpay/invoice-ai'
import { CLI_VERSION, WEBHOOK_EVENT_TYPES } from '../constants'
import type { Ctx } from '../context'
import { CliError, ExitCode, usageError } from '../errors'
import { webhookColumns } from '../output/columns'
import { pageParams, runList, withListOptions, type Act, type ListOptions } from './shared'

function parseEvents(value: string | undefined): WebhookEventType[] {
  if (!value) return []
  const events = value.split(',').map((e) => e.trim()).filter(Boolean)
  const unknown = events.filter((e) => !(WEBHOOK_EVENT_TYPES as readonly string[]).includes(e))
  if (unknown.length) {
    throw usageError(`Unknown event type${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}.`, `Known types: ${WEBHOOK_EVENT_TYPES.join(', ')}.`)
  }
  return events as WebhookEventType[]
}

export function registerWebhooks(program: Command, act: Act): void {
  const webhooks = program.command('webhooks').description('Manage webhook endpoints and test your receiver')

  withListOptions(webhooks.command('list').description('List webhook endpoints')).action(
    act<ListOptions>(async (ctx, _args, opts) => {
      const client = await ctx.client()
      await runList(ctx, client.webhookEndpoints.list(pageParams(opts)), webhookColumns, opts)
    }),
  )

  webhooks
    .command('create')
    .description('Register an https endpoint (prints the signing secret once)')
    .requiredOption('--url <url>', 'https URL that will receive events')
    .option('--events <types>', `comma-separated event types (default: all). ${WEBHOOK_EVENT_TYPES.join(', ')}`)
    .action(
      act<{ url: string; events?: string }>(async (ctx, _args, opts) => {
        const events = parseEvents(opts.events)
        const client = await ctx.client()
        const body: WebhookEndpointCreateParams = { url: opts.url, ...(events.length ? { events } : {}) }
        const endpoint = await client.webhookEndpoints.create(body)
        if (ctx.format === 'json') return ctx.out(JSON.stringify(endpoint, null, 2))
        ctx.success(`Created webhook endpoint ${endpoint.id}`)
        ctx.printObject(endpoint as unknown as Record<string, unknown>)
        const secret = (endpoint as { secret?: string }).secret
        if (secret) ctx.warn(`Save the signing secret now; it won't be shown again:\n\n    ${secret}\n`)
      }),
    )

  webhooks
    .command('delete <id>')
    .description('Delete a webhook endpoint (deliveries stop immediately)')
    .action(
      act(async (ctx, [id]) => {
        await ctx.confirm(`Delete webhook endpoint ${id}?`)
        const client = await ctx.client()
        await client.webhookEndpoints.del(id!)
        ctx.success(`Deleted webhook endpoint ${id}`)
        if (ctx.format === 'json') ctx.out(JSON.stringify({ id, deleted: true }, null, 2))
      }),
    )

  webhooks
    .command('test <url>')
    .description('Send a correctly signed sample event to your receiver (no API key needed)')
    .requiredOption('--secret <whsec>', "the endpoint's signing secret (whsec_…)")
    .option('--event <type>', 'event type to send', 'invoice.paid')
    .addHelpText(
      'after',
      '\nSigns the body exactly like a real delivery (Standard Webhooks: webhook-id,\nwebhook-timestamp, webhook-signature), so your verification code runs for real.\n\nExample:\n  $ invoice-ai webhooks test http://localhost:3000/webhooks --secret whsec_…',
    )
    .action(
      act<{ secret: string; event: string }>(async (ctx, [url], opts) => {
        await sendTestEvent(ctx, url!, opts.secret, opts.event)
      }),
    )
}

/** A sample Invoice matching the REST shape (webhook payload v2), status paid. */
export function sampleInvoice(nowIso: string): Invoice {
  return {
    id: 'in_test_' + randomUUID().replace(/-/g, '').slice(0, 20),
    object: 'invoice',
    number: 'INV-TEST-0001',
    status: 'paid',
    customer: 'cus_test_0000000000000000',
    currency: 'USD',
    collection_method: 'send_invoice',
    issue_date: nowIso.slice(0, 10),
    due_date: nowIso.slice(0, 10),
    description: 'Sample invoice sent by `invoice-ai webhooks test`',
    footer: null,
    subtotal: 250000,
    discount: 0,
    taxable: 250000,
    tax: 0,
    total: 250000,
    amount_due: 0,
    amount_in_words: 'Two Thousand Five Hundred USD Only',
    public_url_token: 'test_token',
    finalized_at: nowIso,
    paid_at: nowIso,
    voided_at: null,
    void_reason: null,
    created: nowIso,
    updated: nowIso,
  } as Invoice
}

/** Builds and signs a sample event; exported for tests. */
export async function buildSignedTestEvent(secret: string, type: WebhookEventType, now: Date) {
  const iso = now.toISOString()
  const event = { id: randomUUID(), type, created_at: iso, data: { object: sampleInvoice(iso) } }
  const body = JSON.stringify(event)
  const headers = await new Webhooks().sign(body, secret, {
    id: `msg_${randomUUID().replace(/-/g, '')}`,
    timestamp: Math.floor(now.getTime() / 1000),
  })
  return { event, body, headers }
}

async function sendTestEvent(ctx: Ctx, url: string, secret: string, type: string): Promise<void> {
  if (!/^https?:\/\//.test(url)) throw usageError(`"${url}" is not an http(s) URL.`)
  if (!secret.startsWith('whsec_')) throw usageError('--secret must be the endpoint signing secret (starts with whsec_).')
  const [eventType] = parseEvents(type)
  const { event, body, headers } = await buildSignedTestEvent(secret, eventType!, new Date(ctx.deps.now()))

  const started = ctx.deps.now()
  let res: Response
  try {
    res = await ctx.deps.fetch(url, {
      method: 'POST',
      headers: {
        ...headers,
        'content-type': 'application/json; charset=utf-8',
        'user-agent': `Invoice-AI-Webhooks/1.0 (invoice-ai-cli/${CLI_VERSION} test)`,
      },
      body,
    })
  } catch (cause) {
    throw new CliError(`Could not reach ${url}: ${cause instanceof Error ? cause.message : String(cause)}`, ExitCode.API)
  }
  const ms = ctx.deps.now() - started
  const text = await res.text().catch(() => '')

  if (ctx.format === 'json') {
    ctx.out(JSON.stringify({ url, status: res.status, ok: res.ok, duration_ms: ms, event_id: event.id, webhook_id: headers['webhook-id'], response: text.slice(0, 2000) }, null, 2))
  } else {
    ctx.info(`Sent ${eventType} (${headers['webhook-id']}) to ${url}`)
    ctx.info(`${res.ok ? ctx.ce.green(String(res.status)) : ctx.ce.red(String(res.status))} in ${ms} ms`)
    if (text) ctx.info(ctx.ce.dim(text.length > 500 ? `${text.slice(0, 500)}…` : text))
  }
  if (!res.ok) {
    throw new CliError(`Your endpoint answered ${res.status}.`, ExitCode.API, 'A receiver should return 2xx once the signature verifies.')
  }
  if (ctx.format !== 'json') ctx.success('Endpoint accepted the signed event')
}
