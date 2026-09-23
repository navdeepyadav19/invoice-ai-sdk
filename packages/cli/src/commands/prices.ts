import type { Command } from 'commander'
import { toMinor, type PriceCreateParams, type PriceUpdateParams } from '@horizonpay/invoice-ai'
import { usageError } from '../errors'
import { priceColumns, priceSummary } from '../output/columns'
import { defined, parseBool, parseNonNegativeInt, parsePercent, parsePositiveInt, readDataObject } from '../util/parse'
import { pageParams, runList, withData, withListOptions, type Act, type ListOptions } from './shared'

interface PriceCreateFlags {
  product?: string
  amount?: string
  unitAmount?: number
  currency?: string
  nickname?: string
  interval?: string
  intervalCount?: number
  taxRate?: number
  data?: string
}

interface PriceUpdateFlags {
  nickname?: string
  taxRate?: number
  data?: string
}

export function registerPrices(program: Command, act: Act): void {
  const prices = program.command('prices').description('Manage prices (what a product costs, per currency)')

  withListOptions(
    prices
      .command('list')
      .description('List prices')
      .option('--product <id>', 'only prices of this product')
      .option('--currency <code>', 'only this currency, e.g. USD')
      .option('--type <type>', 'one_time or recurring')
      .option('--active <bool>', 'only active (true) or archived (false) prices', parseBool),
  ).action(
    act<ListOptions & { product?: string; currency?: string; type?: string; active?: boolean }>(async (ctx, _args, opts) => {
      if (opts.type && opts.type !== 'one_time' && opts.type !== 'recurring') {
        throw usageError(`Unknown --type "${opts.type}".`, 'Use one_time or recurring.')
      }
      const client = await ctx.client()
      const pending = client.prices.list({
        ...pageParams(opts),
        ...defined({
          product: opts.product,
          currency: opts.currency?.toUpperCase(),
          type: opts.type as 'one_time' | 'recurring' | undefined,
          active: opts.active,
        }),
      })
      await runList(ctx, pending, priceColumns, opts)
    }),
  )

  prices
    .command('get <id>')
    .description('Show one price')
    .action(
      act(async (ctx, [id]) => {
        const client = await ctx.client()
        ctx.printObject(await client.prices.retrieve(id!), { columns: priceColumns, summary: priceSummary })
      }),
    )

  withData(
    prices
      .command('create')
      .description('Create a price for a product')
      .option('--product <id>', 'the product this price belongs to')
      .option('--amount <decimal>', 'amount in major units, e.g. 25.00 (converted using the currency)')
      .option('--unit-amount <minor>', 'amount in minor units, e.g. 2500 for $25.00', parseNonNegativeInt)
      .option('--currency <code>', 'ISO 4217 code, e.g. USD')
      .option('--nickname <text>', 'label shown in the dashboard')
      .option('--interval <interval>', 'makes it recurring: day, week, month or year')
      .option('--interval-count <n>', 'intervals between bills (default 1)', parsePositiveInt)
      .option('--tax-rate <percent>', 'default tax percentage for lines billed from this price', parsePercent),
  )
    .addHelpText('after', '\nExample:\n  $ invoice-ai prices create --product prod_123 --amount 25.00 --currency USD')
    .action(
      act<PriceCreateFlags>(async (ctx, _args, opts) => {
        const body: Record<string, unknown> = { ...(await readDataObject(opts.data, ctx.deps.readStdin)) }
        Object.assign(
          body,
          defined({
            product: opts.product,
            currency: opts.currency?.toUpperCase(),
            nickname: opts.nickname,
            tax_rate: opts.taxRate,
          }),
        )
        if (opts.amount !== undefined && opts.unitAmount !== undefined) {
          throw usageError('Pass --amount or --unit-amount, not both.')
        }
        if (opts.amount !== undefined) {
          const currency = typeof body.currency === 'string' ? body.currency : undefined
          if (!currency) throw usageError('--amount needs --currency to know how many decimals to use.')
          try {
            body.unit_amount = toMinor(opts.amount, currency)
          } catch (e) {
            throw usageError(`Invalid --amount: ${(e as Error).message}`)
          }
        }
        if (opts.unitAmount !== undefined) body.unit_amount = opts.unitAmount
        if (opts.interval) {
          if (!['day', 'week', 'month', 'year'].includes(opts.interval)) {
            throw usageError(`Unknown --interval "${opts.interval}".`, 'Use day, week, month or year.')
          }
          body.type = 'recurring'
          body.recurring = { interval: opts.interval, ...(opts.intervalCount ? { interval_count: opts.intervalCount } : {}) }
        }
        const missing = ['product', 'unit_amount', 'currency'].filter((k) => body[k] === undefined)
        if (missing.length) {
          throw usageError(
            `Missing ${missing.join(', ')}.`,
            'Example: invoice-ai prices create --product prod_123 --amount 25.00 --currency USD',
          )
        }
        const client = await ctx.client()
        const price = await client.prices.create(body as PriceCreateParams)
        ctx.success(`Created price ${price.id}`)
        ctx.printObject(price, { columns: priceColumns, summary: priceSummary })
      }),
    )

  withData(
    prices
      .command('update <id>')
      .description('Update a price (nickname, default tax rate)')
      .option('--nickname <text>', 'label shown in the dashboard ("" clears it)')
      .option('--tax-rate <percent>', 'default tax percentage for new lines billed from this price', parsePercent),
  )
    .addHelpText(
      'after',
      '\nAmount, currency and interval changes go through --data. The product can\'t change;\ncreate a new price instead.\n\nExample:\n  $ invoice-ai prices update price_123 --nickname "Annual" --tax-rate 18',
    )
    .action(
      act<PriceUpdateFlags>(async (ctx, [id], opts) => {
        const body = {
          ...(await readDataObject(opts.data, ctx.deps.readStdin)),
          ...defined({ nickname: opts.nickname, tax_rate: opts.taxRate }),
        }
        if (Object.keys(body).length === 0) {
          throw usageError('Nothing to update.', 'Pass --nickname, --tax-rate or --data.')
        }
        const client = await ctx.client()
        const price = await client.prices.update(id!, body as PriceUpdateParams)
        ctx.success(`Updated price ${price.id}`)
        ctx.printObject(price, { columns: priceColumns, summary: priceSummary })
      }),
    )

  prices
    .command('archive <id>')
    .description('Archive a price (it can no longer be added to invoices)')
    .action(
      act(async (ctx, [id]) => {
        await ctx.confirm(`Archive price ${id}?`)
        const client = await ctx.client()
        const price = await client.prices.archive(id!)
        ctx.success(`Archived price ${price.id}`)
        if (ctx.format !== 'table') ctx.printObject(price, { columns: priceColumns })
      }),
    )
}
