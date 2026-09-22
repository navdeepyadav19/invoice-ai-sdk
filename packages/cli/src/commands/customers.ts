import type { Command } from 'commander'
import type { CustomerCreateParams, CustomerUpdateParams } from '@horizonpay/invoice-ai'
import { usageError } from '../errors'
import { customerColumns } from '../output/columns'
import { defined, readDataObject } from '../util/parse'
import { pageParams, runList, withData, withListOptions, type Act, type ListOptions } from './shared'

interface CustomerFlags {
  name?: string
  email?: string
  phone?: string
  taxId?: string
  data?: string
}

function customerFields(cmd: Command): Command {
  return withData(
    cmd
      .option('--name <name>', 'customer name')
      .option('--email <email>', 'billing email (invoices are sent here)')
      .option('--phone <phone>', 'phone number')
      .option('--tax-id <id>', 'tax id, e.g. a GSTIN or VAT number'),
  )
}

export function registerCustomers(program: Command, act: Act): void {
  const customers = program.command('customers').description('Manage customers (the people and companies you bill)')

  withListOptions(
    customers
      .command('list')
      .description('List customers, newest first')
      .option('-q, --query <text>', 'search name and email')
      .option('--include-deleted', 'include archived customers'),
  ).action(
    act<ListOptions & { query?: string; includeDeleted?: boolean }>(async (ctx, _args, opts) => {
      const client = await ctx.client()
      const pending = client.customers.list({
        ...pageParams(opts),
        ...(opts.query ? { query: opts.query } : {}),
        ...(opts.includeDeleted ? { include_deleted: true } : {}),
      })
      await runList(ctx, pending, customerColumns, opts)
    }),
  )

  customers
    .command('get <id>')
    .description('Show one customer')
    .action(
      act(async (ctx, [id]) => {
        const client = await ctx.client()
        ctx.printObject(await client.customers.retrieve(id!), { columns: customerColumns })
      }),
    )

  customerFields(customers.command('create').description('Create a customer')).action(
    act<CustomerFlags>(async (ctx, _args, opts) => {
      const body = { ...(await readDataObject(opts.data, ctx.deps.readStdin)), ...flagsToBody(opts) }
      if (typeof body.name !== 'string' || !body.name) {
        throw usageError('A customer needs a name.', 'Pass --name "Acme Corp" (or "name" in --data).')
      }
      const client = await ctx.client()
      const customer = await client.customers.create(body as CustomerCreateParams)
      ctx.success(`Created customer ${customer.id}`)
      ctx.printObject(customer, { columns: customerColumns })
    }),
  )

  customerFields(customers.command('update <id>').description('Update a customer (only the fields you pass change)')).action(
    act<CustomerFlags>(async (ctx, [id], opts) => {
      const body = { ...(await readDataObject(opts.data, ctx.deps.readStdin)), ...flagsToBody(opts) }
      if (Object.keys(body).length === 0) throw usageError('Nothing to update.', 'Pass at least one field, e.g. --email.')
      const client = await ctx.client()
      const customer = await client.customers.update(id!, body as CustomerUpdateParams)
      ctx.success(`Updated customer ${customer.id}`)
      ctx.printObject(customer, { columns: customerColumns })
    }),
  )

  customers
    .command('archive <id>')
    .alias('delete')
    .description('Archive a customer (issued invoices keep referencing it)')
    .action(
      act(async (ctx, [id]) => {
        await ctx.confirm(`Archive customer ${id}?`)
        const client = await ctx.client()
        const customer = await client.customers.del(id!)
        ctx.success(`Archived customer ${customer.id}`)
        if (ctx.format !== 'table') ctx.printObject(customer, { columns: customerColumns })
      }),
    )
}

function flagsToBody(opts: CustomerFlags): Record<string, unknown> {
  return defined({ name: opts.name, email: opts.email, phone: opts.phone, tax_id: opts.taxId })
}
