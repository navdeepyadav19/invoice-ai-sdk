import { Option, type Command } from 'commander'
import { toMinor, type InvoiceItemCreateParams } from '@horizonpay/invoice-ai'
import { usageError } from '../errors'
import { invoiceItemColumns, money } from '../output/columns'
import { defined, parseNonNegativeInt, parsePercent, parsePositiveNumber, readDataObject } from '../util/parse'
import { printInvoice } from './invoices'
import { withData, type Act } from './shared'

const UNITS = ['NOS', 'PCS', 'KGS', 'GMS', 'LTR', 'MTR', 'SQF', 'SQM', 'HRS', 'DAY', 'MON', 'BOX', 'SET', 'OTH'] as const

interface ItemCreateFlags {
  invoice?: string
  price?: string
  description?: string
  qty?: number
  unit?: string
  amount?: string
  unitAmount?: number
  currency?: string
  discount?: number
  taxRate?: number
  data?: string
}

/**
 * `invoice-ai invoice-items`: the lines of a draft invoice, one at a time.
 * Adding or removing a line returns the whole recomputed invoice, so both
 * print the invoice (new totals) rather than the line.
 */
export function registerInvoiceItems(program: Command, act: Act): void {
  const items = program.command('invoice-items').description('Add, inspect and remove the lines of a draft invoice')

  items
    .command('list')
    .description("List an invoice's lines, in order")
    .option('--invoice <id>', 'the invoice (in_…), required')
    .action(
      act<{ invoice?: string }>(async (ctx, _args, opts) => {
        if (!opts.invoice) throw usageError('Which invoice?', 'Pass --invoice in_… (see `invoice-ai invoices list`).')
        const client = await ctx.client()
        const page = await client.invoiceItems.list({ invoice: opts.invoice })
        ctx.printList(page.data, invoiceItemColumns, null)
      }),
    )

  items
    .command('get <id>')
    .description('Show one line (ii_…)')
    .action(
      act(async (ctx, [id]) => {
        const client = await ctx.client()
        ctx.printObject(await client.invoiceItems.retrieve(id!), { columns: invoiceItemColumns })
      }),
    )

  withData(
    items
      .command('create')
      .description('Add a line to a draft: from a --price, or ad hoc with --description and an amount')
      .option('--invoice <id>', 'the draft to add to (in_…), required')
      .option('--price <id>', 'bill from this catalog price (fills description, amount and tax rate)')
      .option('--description <text>', 'what you are billing for (required without --price)')
      .option('--qty <n>', 'quantity, may be fractional (default 1)', parsePositiveNumber)
      .addOption(new Option('--unit <unit>', 'unit of measure (default NOS)').choices(UNITS))
      .option('--amount <decimal>', 'unit amount in major units, e.g. 25.00 (uses the invoice currency)')
      .option('--unit-amount <minor>', 'unit amount in minor units, e.g. 2500 for $25.00', parseNonNegativeInt)
      .option('--currency <code>', 'currency for --amount (defaults to the invoice currency)')
      .option('--discount <percent>', 'discount percentage applied before tax', parsePercent)
      .option('--tax-rate <percent>', 'tax percentage added on top (defaults to the price rate, or 0)', parsePercent),
  )
    .addHelpText(
      'after',
      '\nExamples:\n  $ invoice-ai invoice-items create --invoice in_123 --price price_abc --qty 3\n  $ invoice-ai invoice-items create --invoice in_123 --description "Rush fee" --amount 50',
    )
    .action(
      act<ItemCreateFlags>(async (ctx, _args, opts) => {
        const body: Record<string, unknown> = {
          ...(await readDataObject(opts.data, ctx.deps.readStdin)),
          ...defined({
            invoice: opts.invoice,
            price: opts.price,
            description: opts.description,
            quantity: opts.qty,
            unit: opts.unit,
            discount_percent: opts.discount,
            tax_rate: opts.taxRate,
          }),
        }
        if (typeof body.invoice !== 'string' || !body.invoice) {
          throw usageError('Which invoice?', 'Pass --invoice in_… (a draft; see `invoice-ai invoices list --status draft`).')
        }
        if (opts.amount !== undefined && opts.unitAmount !== undefined) {
          throw usageError('Pass --amount or --unit-amount, not both.')
        }
        if (opts.unitAmount !== undefined) body.unit_amount = opts.unitAmount

        const client = await ctx.client()
        if (opts.amount !== undefined) {
          // Minor units depend on the currency; a line always bills in the
          // invoice's currency, so look it up unless --currency says it.
          const currency = opts.currency?.toUpperCase() ?? (await client.invoices.retrieve(body.invoice)).currency
          try {
            body.unit_amount = toMinor(opts.amount, currency)
          } catch (e) {
            throw usageError(`Invalid --amount: ${(e as Error).message}`)
          }
        }
        if (body.price === undefined && (body.description === undefined || body.unit_amount === undefined)) {
          throw usageError(
            'A line needs a --price, or a --description and an amount.',
            'Example: invoice-ai invoice-items create --invoice in_123 --description "Rush fee" --amount 50',
          )
        }

        const invoice = await client.invoiceItems.create(body as InvoiceItemCreateParams)
        ctx.success(`Added a line to ${invoice.id} · total ${money(invoice.total, invoice.currency)}`)
        printInvoice(ctx, invoice)
      }),
    )

  items
    .command('delete <id>')
    .description('Remove a line from a draft (a draft keeps at least one line)')
    .option('--invoice <id>', 'the invoice the line belongs to (speeds up the lookup)')
    .action(
      act<{ invoice?: string }>(async (ctx, [id], opts) => {
        await ctx.confirm(`Remove line ${id}?`)
        const client = await ctx.client()
        const invoice = await client.invoiceItems.del(id!, opts.invoice ? { invoice: opts.invoice } : undefined)
        ctx.success(`Removed line ${id} from ${invoice.id} · total ${money(invoice.total, invoice.currency)}`)
        if (ctx.format !== 'table') printInvoice(ctx, invoice)
      }),
    )
}
