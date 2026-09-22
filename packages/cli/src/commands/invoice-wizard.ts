import * as p from '@clack/prompts'
import type { Customer, InvoiceCreateParams, Price, Product } from '@horizonpay/invoice-ai'
import type { Ctx } from '../context'
import { CliError, ExitCode } from '../errors'
import { money } from '../output/columns'
import { printInvoice } from './invoices'

/**
 * `invoice-ai invoices create` with no flags:
 *
 *   1. search customers (SDK list with `query`) and pick one
 *   2. add lines: pick an active price, enter a quantity, repeat
 *   3. confirm the estimated subtotal, create the draft
 *   4. optionally finalize, or finalize and send (showing the recipient first)
 *
 * Only reached when stdin/stdout are terminals (`ctx.requireInteractive`).
 */

function unwrap<T>(value: T | symbol): T {
  if (p.isCancel(value)) {
    p.cancel('Cancelled. Nothing was created.')
    throw new CliError('Cancelled.', ExitCode.API)
  }
  return value as T
}

export async function runInvoiceWizard(ctx: Ctx): Promise<void> {
  const client = await ctx.client()
  p.intro(ctx.c.bold('New invoice'))

  // 1. Customer ------------------------------------------------------------
  let customer: Customer | undefined
  while (!customer) {
    const query = unwrap(
      await p.text({ message: 'Search customers', placeholder: 'name or email (Enter lists recent customers)', defaultValue: '' }),
    ).trim()
    const s = p.spinner()
    s.start('Searching')
    const page = await client.customers.list({ limit: 20, ...(query ? { query } : {}) })
    s.stop(`${page.data.length} match${page.data.length === 1 ? '' : 'es'}`)
    if (page.data.length === 0) {
      p.log.warn(query ? `No customers match "${query}". Try another search.` : 'No customers yet. Create one with `invoice-ai customers create`.')
      if (!query) throw new CliError('No customers to bill.', ExitCode.USAGE, 'Run `invoice-ai customers create --name "Acme"` first.')
      continue
    }
    const choice = unwrap(
      await p.select<string>({
        message: 'Bill to',
        options: [
          ...page.data.map((c) => ({ value: c.id, label: c.name, hint: c.email ?? c.id })),
          { value: '__search__', label: ctx.c.dim('Search again…') },
        ],
      }),
    )
    if (choice !== '__search__') customer = page.data.find((c) => c.id === choice)
  }

  // 2. Lines ---------------------------------------------------------------
  const s = p.spinner()
  s.start('Loading your catalog')
  const [prices, products] = await Promise.all([
    client.prices.list({ active: true, limit: 100 }).toArray({ limit: 500 }),
    client.products.list({ limit: 100 }).toArray({ limit: 500 }),
  ])
  s.stop(`${prices.length} active price${prices.length === 1 ? '' : 's'}`)
  if (prices.length === 0) {
    throw new CliError('Your catalog has no active prices.', ExitCode.USAGE, 'Add one: `invoice-ai prices create --product prod_… --amount 25 --currency USD`.')
  }
  const productName = new Map<string, Product>(products.map((pr) => [pr.id, pr]))
  const label = (pr: Price) => {
    const name = (pr.product && productName.get(pr.product)?.name) ?? pr.product ?? 'Custom price'
    return `${name}${pr.nickname ? ` · ${pr.nickname}` : ''}`
  }

  const lines: { price: Price; quantity: number }[] = []
  let currency: string | undefined
  for (;;) {
    const choices = prices.filter((pr) => !currency || pr.currency === currency)
    const priceId = unwrap(
      await p.select<string>({
        message: lines.length ? 'Add another line' : 'Add a line',
        options: choices.map((pr) => ({ value: pr.id, label: label(pr), hint: money(pr.unit_amount, pr.currency) })),
        maxItems: 10,
      }),
    )
    const price = choices.find((pr) => pr.id === priceId)!
    const quantity = Number(
      unwrap(
        await p.text({
          message: 'Quantity',
          defaultValue: '1',
          placeholder: '1',
          validate: (v) => {
            const n = Number(v === '' ? '1' : v)
            return Number.isFinite(n) && n > 0 ? undefined : 'Enter a positive number'
          },
        }),
      ) || '1',
    )
    lines.push({ price, quantity })
    currency ??= price.currency
    const more = unwrap(await p.confirm({ message: 'Add another line?', initialValue: false }))
    if (!more) break
  }

  // 3. Confirm -------------------------------------------------------------
  const subtotal = lines.reduce((sum, l) => sum + Math.round(l.price.unit_amount * l.quantity), 0)
  p.note(
    [
      `${ctx.c.dim('Customer')}  ${customer.name}${customer.email ? ` <${customer.email}>` : ''}`,
      ...lines.map((l) => `${ctx.c.dim('Line')}      ${l.quantity} × ${label(l.price)} @ ${money(l.price.unit_amount, l.price.currency)}`),
      `${ctx.c.dim('Subtotal')}  ${money(subtotal, currency!)} ${ctx.c.dim('(before tax and discounts)')}`,
    ].join('\n'),
    'Review',
  )
  if (!unwrap(await p.confirm({ message: 'Create this draft invoice?', initialValue: true }))) {
    p.cancel('Nothing was created.')
    return
  }

  const body: InvoiceCreateParams = {
    customer: customer.id,
    currency,
    items: lines.map((l) => ({ price: l.price.id, quantity: l.quantity })),
  }
  let invoice = await client.invoices.create(body)
  p.log.success(`Created draft ${invoice.id} · total ${money(invoice.total, invoice.currency)}`)

  // 4. Next step -----------------------------------------------------------
  const next = unwrap(
    await p.select<'draft' | 'finalize' | 'send'>({
      message: 'What next?',
      options: [
        { value: 'draft', label: 'Keep it as a draft' },
        { value: 'finalize', label: 'Finalize', hint: 'assigns a number, locks the lines' },
        { value: 'send', label: 'Finalize and send', hint: customer.email ?? 'no email on file' },
      ],
    }),
  )
  if (next === 'send') {
    if (!customer.email) {
      p.log.warn(`${customer.name} has no email on file; finalizing only. Send later with \`invoice-ai invoices send ${invoice.id} --to …\`.`)
      invoice = await client.invoices.finalize(invoice.id)
    } else if (unwrap(await p.confirm({ message: `Email it to ${customer.email}?`, initialValue: true }))) {
      const sent = await client.invoices.send(invoice.id)
      invoice = sent.data
      p.log.success(`Sent ${invoice.number ?? invoice.id} to ${sent.emailed_to}`)
    }
  } else if (next === 'finalize') {
    invoice = await client.invoices.finalize(invoice.id)
    p.log.success(`Finalized as ${invoice.number ?? invoice.id}`)
  }
  p.outro(`Done. ${ctx.c.dim(`invoice-ai invoices get ${invoice.id}`)}`)
  if (ctx.format !== 'table') printInvoice(ctx, invoice)
}
