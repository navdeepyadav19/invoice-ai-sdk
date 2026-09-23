import {
  formatMoney,
  type Customer,
  type Invoice,
  type InvoiceEvent,
  type InvoiceItem,
  type Price,
  type Product,
  type WebhookEndpoint,
} from '@horizonpay/invoice-ai'
import type { Colors } from '../util/colors'
import type { Column } from './format'

/** Column sets per resource: what `list` shows as a table and writes as CSV. */

const date = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : '—')

export function money(amount: number | null | undefined, currency: string | null | undefined): string {
  if (amount === null || amount === undefined || !currency) return '—'
  try {
    return formatMoney(amount, currency)
  } catch {
    return `${amount} ${currency}`
  }
}

export function statusColor(status: string, c: Colors): string {
  switch (status) {
    case 'paid':
      return c.green(status)
    case 'open':
      return c.cyan(status)
    case 'overdue':
      return c.red(status)
    case 'void':
      return c.dim(status)
    default:
      return c.yellow(status)
  }
}

export const customerColumns: Column<Customer>[] = [
  { header: 'ID', value: (r) => r.id },
  { header: 'NAME', value: (r) => r.name },
  { header: 'EMAIL', value: (r) => r.email },
  { header: 'CREATED', value: (r) => r.created, display: (r) => date(r.created) },
]

export const productColumns: Column<Product>[] = [
  { header: 'ID', value: (r) => r.id },
  { header: 'NAME', value: (r) => r.name },
  { header: 'ACTIVE', value: (r) => r.active, display: (r, c) => (r.active ? 'yes' : c.dim('no')) },
  { header: 'CREATED', value: (r) => r.created, display: (r) => date(r.created) },
]

export const priceColumns: Column<Price>[] = [
  { header: 'ID', value: (r) => r.id },
  { header: 'PRODUCT', value: (r) => r.product },
  { header: 'NICKNAME', value: (r) => r.nickname },
  { header: 'AMOUNT', value: (r) => r.unit_amount, display: (r) => money(r.unit_amount, r.currency) },
  { header: 'CURRENCY', value: (r) => r.currency },
  { header: 'TYPE', value: (r) => r.type },
  { header: 'ACTIVE', value: (r) => r.active, display: (r, c) => (r.active ? 'yes' : c.dim('no')) },
]

export const invoiceColumns: Column<Invoice>[] = [
  { header: 'ID', value: (r) => r.id },
  { header: 'NUMBER', value: (r) => r.number },
  { header: 'STATUS', value: (r) => r.status, display: (r, c) => statusColor(r.status, c) },
  { header: 'CUSTOMER', value: (r) => r.customer },
  { header: 'TOTAL', value: (r) => r.total, display: (r) => money(r.total, r.currency) },
  { header: 'CURRENCY', value: (r) => r.currency },
  { header: 'DUE', value: (r) => r.due_date, display: (r) => date(r.due_date) },
]

/** Lines carry no currency of their own, so amounts stay in minor units. */
export const invoiceItemColumns: Column<InvoiceItem>[] = [
  { header: 'ID', value: (r) => r.id },
  { header: 'DESCRIPTION', value: (r) => r.description },
  { header: 'QTY', value: (r) => r.quantity },
  { header: 'UNIT', value: (r) => r.unit },
  { header: 'UNIT AMOUNT', value: (r) => r.unit_amount },
  { header: 'TAX %', value: (r) => r.tax_rate },
  { header: 'AMOUNT', value: (r) => r.amount },
  { header: 'PRICE', value: (r) => r.price },
]

export const invoiceEventColumns: Column<InvoiceEvent>[] = [
  { header: 'ID', value: (r) => r.id },
  { header: 'TYPE', value: (r) => r.type },
  { header: 'CREATED', value: (r) => r.created_at },
]

export const webhookColumns: Column<WebhookEndpoint>[] = [
  { header: 'ID', value: (r) => r.id },
  { header: 'URL', value: (r) => r.url },
  {
    header: 'EVENTS',
    value: (r) => (r.events.length ? r.events.join(' ') : '*'),
    display: (r) => (r.events.length ? r.events.join(', ') : 'all'),
  },
  { header: 'ACTIVE', value: (r) => r.active, display: (r, c) => (r.active ? 'yes' : c.red('disabled')) },
  { header: 'FAILURES', value: (r) => r.failure_count },
]

/** The fields `get` shows for one invoice in table mode (money formatted). */
export function invoiceSummary(inv: Invoice, c: Colors): Record<string, unknown> {
  return {
    id: inv.id,
    number: inv.number,
    status: statusColor(inv.status, c),
    customer: inv.customer,
    currency: inv.currency,
    issue_date: inv.issue_date,
    due_date: inv.due_date,
    subtotal: money(inv.subtotal, inv.currency),
    discount: money(inv.discount, inv.currency),
    tax: money(inv.tax, inv.currency),
    total: money(inv.total, inv.currency),
    amount_due: money(inv.amount_due, inv.currency),
    description: inv.description,
    lines: inv.lines?.data?.length,
    finalized_at: inv.finalized_at,
    paid_at: inv.paid_at,
    voided_at: inv.voided_at,
    created: inv.created,
  }
}

export function priceSummary(p: Price): Record<string, unknown> {
  return { ...p, unit_amount: `${money(p.unit_amount, p.currency)} (${p.unit_amount})` }
}
