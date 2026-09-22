import type { Command } from 'commander'
import type { ProductCreateParams, ProductUpdateParams } from '@horizonpay/invoice-ai'
import { usageError } from '../errors'
import { productColumns } from '../output/columns'
import { defined, parseBool, readDataObject } from '../util/parse'
import { pageParams, runList, withData, withListOptions, type Act, type ListOptions } from './shared'

interface ProductFlags {
  name?: string
  description?: string
  active?: boolean
  data?: string
}

function productFields(cmd: Command): Command {
  return withData(
    cmd
      .option('--name <name>', 'product name, shown on invoice lines')
      .option('--description <text>', 'longer description')
      .option('--active <bool>', 'whether it can be added to new invoices (true/false)', parseBool),
  )
}

export function registerProducts(program: Command, act: Act): void {
  const products = program.command('products').description('Manage products in your catalog')

  withListOptions(
    products
      .command('list')
      .description('List products')
      .option('-q, --query <text>', 'search by name')
      .option('--active <bool>', 'only active (true) or archived (false) products', parseBool),
  ).action(
    act<ListOptions & { query?: string; active?: boolean }>(async (ctx, _args, opts) => {
      const client = await ctx.client()
      const pending = client.products.list({
        ...pageParams(opts),
        ...(opts.query ? { query: opts.query } : {}),
        ...(opts.active !== undefined ? { active: opts.active } : {}),
      })
      await runList(ctx, pending, productColumns, opts)
    }),
  )

  products
    .command('get <id>')
    .description('Show one product')
    .action(
      act(async (ctx, [id]) => {
        const client = await ctx.client()
        ctx.printObject(await client.products.retrieve(id!), { columns: productColumns })
      }),
    )

  productFields(products.command('create').description('Create a product (then add a price with `prices create`)')).action(
    act<ProductFlags>(async (ctx, _args, opts) => {
      const body = { ...(await readDataObject(opts.data, ctx.deps.readStdin)), ...flagsToBody(opts) }
      if (typeof body.name !== 'string' || !body.name) {
        throw usageError('A product needs a name.', 'Pass --name "Design retainer" (or "name" in --data).')
      }
      const client = await ctx.client()
      const product = await client.products.create(body as ProductCreateParams)
      ctx.success(`Created product ${product.id}`)
      ctx.printObject(product, { columns: productColumns })
    }),
  )

  productFields(products.command('update <id>').description('Update a product (only the fields you pass change)')).action(
    act<ProductFlags>(async (ctx, [id], opts) => {
      const body = { ...(await readDataObject(opts.data, ctx.deps.readStdin)), ...flagsToBody(opts) }
      if (Object.keys(body).length === 0) throw usageError('Nothing to update.', 'Pass at least one field, e.g. --name.')
      const client = await ctx.client()
      const product = await client.products.update(id!, body as ProductUpdateParams)
      ctx.success(`Updated product ${product.id}`)
      ctx.printObject(product, { columns: productColumns })
    }),
  )

  products
    .command('archive <id>')
    .description('Archive a product (existing invoices are unaffected)')
    .action(
      act(async (ctx, [id]) => {
        await ctx.confirm(`Archive product ${id}?`)
        const client = await ctx.client()
        const product = await client.products.archive(id!)
        ctx.success(`Archived product ${product.id}`)
        if (ctx.format !== 'table') ctx.printObject(product, { columns: productColumns })
      }),
    )
}

function flagsToBody(opts: ProductFlags): Record<string, unknown> {
  return defined({ name: opts.name, description: opts.description, active: opts.active })
}
