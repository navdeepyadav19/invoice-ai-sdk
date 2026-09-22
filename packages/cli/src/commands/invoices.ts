import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Command } from 'commander'
import type { Invoice, InvoiceAI, InvoiceCreateParams, InvoiceUpdateParams } from '@horizonpay/invoice-ai'
import type { Ctx } from '../context'
import { usageError } from '../errors'
import { invoiceColumns, invoiceEventColumns, invoiceSummary, money } from '../output/columns'
import { collect, defined, parseNonNegativeInt, parsePositiveNumber, readDataObject } from '../util/parse'
import { pageParams, runList, withData, withListOptions, type Act, type ListOptions } from './shared'

const STATUSES = ['draft', 'open', 'paid', 'overdue', 'void'] as const
const DATE = /^\d{4}-\d{2}-\d{2}$/

interface InvoiceFieldFlags {
  customer?: string
  currency?: string
  dueDate?: string
  daysUntilDue?: number
  description?: string
  footer?: string
  collectionMethod?: string
  price?: string[]
  qty?: string[]
  data?: string
}

interface CreateFlags extends InvoiceFieldFlags {
  finalize?: boolean
  send?: boolean
  interactive?: boolean
}

function invoiceFields(cmd: Command): Command {
  return withData(
    cmd
      .option('--customer <id>', 'customer to bill (cus_…)')
      .option('--price <id>', 'add a line from this price (repeatable)', collect)
      .option('--qty <n>', 'quantity for the --price in the same position (repeatable, default 1)', collect)
      .option('--currency <code>', 'invoice currency (defaults to your business currency)')
      .option('--due-date <YYYY-MM-DD>', 'due date')
      .option('--days-until-due <n>', 'due this many days after finalizing', parseNonNegativeInt)
      .option('--description <text>', 'memo shown on the invoice')
      .option('--footer <text>', 'footer text')
      .option('--collection-method <method>', 'send_invoice (default) or charge_automatically'),
  )
}

/** Builds a create/update body from --data plus flags (flags win). */
export async function invoiceBody(ctx: Ctx, opts: InvoiceFieldFlags): Promise<Record<string, unknown>> {
  const body = { ...(await readDataObject(opts.data, ctx.deps.readStdin)) }
  if (opts.dueDate && !DATE.test(opts.dueDate)) throw usageError('--due-date must be YYYY-MM-DD.')
  if (opts.collectionMethod && !['send_invoice', 'charge_automatically'].includes(opts.collectionMethod)) {
    throw usageError(`Unknown --collection-method "${opts.collectionMethod}".`, 'Use send_invoice or charge_automatically.')
  }
  Object.assign(
    body,
    defined({
      customer: opts.customer,
      currency: opts.currency?.toUpperCase(),
      due_date: opts.dueDate,
      days_until_due: opts.daysUntilDue,
      description: opts.description,
      footer: opts.footer,
      collection_method: opts.collectionMethod,
    }),
  )
  const prices = opts.price ?? []
  const qtys = opts.qty ?? []
  if (qtys.length > prices.length) throw usageError('More --qty than --price flags.', 'Each --qty applies to the --price in the same position.')
  if (prices.length) {
    body.items = prices.map((price, i) => {
      const raw = qtys[i]
      let quantity = 1
      if (raw !== undefined) {
        try {
          quantity = parsePositiveNumber(raw)
        } catch {
          throw usageError(`--qty "${raw}" is not a positive number.`)
        }
      }
      return { price, quantity }
    })
  }
  return body
}

export function registerInvoices(program: Command, act: Act): void {
  const invoices = program.command('invoices').description('Create, send and manage invoices')

  withListOptions(
    invoices
      .command('list')
      .description('List invoices, newest first')
      .option('--status <status>', `only this status: ${STATUSES.join(', ')}`)
      .option('--customer <id>', 'only invoices billed to this customer')
      .option('--from <YYYY-MM-DD>', 'issued on or after this date')
      .option('--to <YYYY-MM-DD>', 'issued on or before this date'),
  ).action(
    act<ListOptions & { status?: string; customer?: string; from?: string; to?: string }>(async (ctx, _args, opts) => {
      if (opts.status && !(STATUSES as readonly string[]).includes(opts.status)) {
        throw usageError(`Unknown --status "${opts.status}".`, `Use one of: ${STATUSES.join(', ')}.`)
      }
      for (const [flag, v] of [['--from', opts.from], ['--to', opts.to]] as const) {
        if (v && !DATE.test(v)) throw usageError(`${flag} must be YYYY-MM-DD.`)
      }
      const client = await ctx.client()
      const pending = client.invoices.list({
        ...pageParams(opts),
        ...defined({
          status: opts.status as (typeof STATUSES)[number] | undefined,
          customer: opts.customer,
          from: opts.from,
          to: opts.to,
        }),
      })
      await runList(ctx, pending, invoiceColumns, opts)
    }),
  )

  invoices
    .command('get <id>')
    .description('Show one invoice with its totals')
    .action(
      act(async (ctx, [id]) => {
        const client = await ctx.client()
        const invoice = await client.invoices.retrieve(id!)
        printInvoice(ctx, invoice)
      }),
    )

  invoiceFields(
    invoices
      .command('create')
      .description('Create an invoice: a guided wizard with no flags, or scripted with flags')
      .option('--finalize', 'finalize it right away (assigns a number, locks the lines)')
      .option('--send', 'finalize and email it to the customer')
      .option('--no-interactive', 'never start the wizard'),
  )
    .addHelpText(
      'after',
      '\nExamples:\n  $ invoice-ai invoices create                      # guided wizard\n  $ invoice-ai invoices create --customer cus_123 --price price_abc --qty 2 --send',
    )
    .action(
      act<CreateFlags>(async (ctx, _args, opts) => {
        const anyField = Boolean(
          opts.customer || opts.price?.length || opts.data || opts.currency || opts.dueDate || opts.description,
        )
        if (!anyField && opts.interactive !== false) {
          ctx.requireInteractive(
            'The invoice wizard',
            'Pass --customer and --price flags instead, e.g. `invoice-ai invoices create --customer cus_123 --price price_abc`.',
          )
          const { runInvoiceWizard } = await import('./invoice-wizard')
          await runInvoiceWizard(ctx)
          return
        }
        const body = await invoiceBody(ctx, opts)
        if (typeof body.customer !== 'string' || !body.customer) {
          throw usageError('An invoice needs a customer.', 'Pass --customer cus_… (see `invoice-ai customers list`).')
        }
        const client = await ctx.client()
        let invoice = await client.invoices.create(body as InvoiceCreateParams)
        ctx.success(`Created draft invoice ${invoice.id} (${money(invoice.total, invoice.currency)})`)
        if (opts.send) {
          const sent = await client.invoices.send(invoice.id)
          invoice = sent.data
          ctx.success(`Sent ${invoice.number ?? invoice.id} to ${sent.emailed_to}`)
        } else if (opts.finalize) {
          invoice = await client.invoices.finalize(invoice.id)
          ctx.success(`Finalized as ${invoice.number ?? invoice.id}`)
        }
        printInvoice(ctx, invoice)
      }),
    )

  invoiceFields(invoices.command('update <id>').description('Update a draft invoice (only the fields you pass change)')).action(
    act<InvoiceFieldFlags>(async (ctx, [id], opts) => {
      const body = await invoiceBody(ctx, opts)
      if (Object.keys(body).length === 0) throw usageError('Nothing to update.', 'Pass at least one field, e.g. --due-date.')
      const client = await ctx.client()
      const invoice = await client.invoices.update(id!, body as InvoiceUpdateParams)
      ctx.success(`Updated invoice ${invoice.id}`)
      printInvoice(ctx, invoice)
    }),
  )

  invoices
    .command('delete <id>')
    .description('Delete a draft invoice (finalized invoices can only be voided)')
    .action(
      act(async (ctx, [id]) => {
        await ctx.confirm(`Delete draft invoice ${id}? This can't be undone.`)
        const client = await ctx.client()
        await client.invoices.del(id!)
        ctx.success(`Deleted invoice ${id}`)
        if (ctx.format === 'json') ctx.out(JSON.stringify({ id, deleted: true }, null, 2))
      }),
    )

  invoices
    .command('finalize <id>')
    .description('Finalize a draft: assigns the number and locks the lines')
    .action(
      act(async (ctx, [id]) => {
        const client = await ctx.client()
        const invoice = await client.invoices.finalize(id!)
        ctx.success(`Finalized ${invoice.number ?? invoice.id}`)
        printInvoice(ctx, invoice)
      }),
    )

  invoices
    .command('send <id>')
    .description('Email the invoice to the customer (finalizes a draft first)')
    .option('--to <email>', "send to this address instead of the customer's email")
    .action(
      act<{ to?: string }>(async (ctx, [id], opts) => {
        const client = await ctx.client()
        const recipient = opts.to ?? (await customerEmail(client, id!))
        ctx.info(`Recipient: ${recipient ?? ctx.ce.yellow("the customer's email on file")}`)
        await ctx.confirm(`Send invoice ${id} to ${recipient ?? 'the customer'}?`)
        const sent = await client.invoices.send(id!, opts.to ? { to: opts.to } : undefined)
        ctx.success(`Sent ${sent.data.number ?? sent.data.id} to ${sent.emailed_to}`)
        if (ctx.format === 'json') ctx.out(JSON.stringify(sent, null, 2))
        else printInvoice(ctx, sent.data)
      }),
    )

  invoices
    .command('pay <id>')
    .description('Record a payment received outside Invoice-AI (marks it paid)')
    .option('--paid-on <date>', 'when the payment arrived (default: now)')
    .option('--reference <ref>', 'your payment reference, e.g. a cheque number')
    .action(
      act<{ paidOn?: string; reference?: string }>(async (ctx, [id], opts) => {
        const client = await ctx.client()
        const params = defined({ paid_on: opts.paidOn, reference: opts.reference })
        const invoice = await client.invoices.pay(id!, Object.keys(params).length ? params : undefined)
        ctx.success(`Marked ${invoice.number ?? invoice.id} paid`)
        printInvoice(ctx, invoice)
      }),
    )

  invoices
    .command('void <id>')
    .description('Void a finalized invoice (it stays on record, marked void)')
    .requiredOption('--reason <text>', 'why it is being voided (kept on the invoice)')
    .action(
      act<{ reason: string }>(async (ctx, [id], opts) => {
        await ctx.confirm(`Void invoice ${id}? This can't be undone.`)
        const client = await ctx.client()
        const invoice = await client.invoices.void(id!, { reason: opts.reason })
        ctx.success(`Voided ${invoice.number ?? invoice.id}`)
        printInvoice(ctx, invoice)
      }),
    )

  invoices
    .command('pdf <id>')
    .description('Download the invoice PDF')
    .option('-o, --out <file>', 'where to save it (default: <id>.pdf; "-" writes to stdout)')
    .option('--open', 'open the PDF once saved')
    .action(
      act<{ out?: string; open?: boolean }>(async (ctx, [id], opts) => {
        const client = await ctx.client()
        const bytes = new Uint8Array(await client.invoices.pdf(id!))
        if (opts.out === '-') {
          ctx.deps.stdout.write(bytes)
          return
        }
        const file = resolve(opts.out ?? `${id}.pdf`)
        await writeFile(file, bytes)
        ctx.success(`Saved ${file} (${Math.max(1, Math.round(bytes.byteLength / 1024))} KB)`)
        if (ctx.format === 'json') ctx.out(JSON.stringify({ id, file, bytes: bytes.byteLength }, null, 2))
        if (opts.open) await ctx.deps.openUrl(file)
      }),
    )

  withListOptions(invoices.command('events <id>').description("Show an invoice's history (created, emailed, viewed, paid…)")).action(
    act<ListOptions>(async (ctx, [id], opts) => {
      const client = await ctx.client()
      await runList(ctx, client.invoices.events(id!, pageParams(opts)), invoiceEventColumns, opts)
    }),
  )
}

export function printInvoice(ctx: Ctx, invoice: Invoice): void {
  ctx.printObject(invoice, { columns: invoiceColumns, summary: (inv) => invoiceSummary(inv, ctx.c) })
}

async function customerEmail(client: InvoiceAI, invoiceId: string): Promise<string | null> {
  const invoice = await client.invoices.retrieve(invoiceId)
  if (!invoice.customer) return null
  const customer = await client.customers.retrieve(invoice.customer)
  return customer.email ?? null
}
