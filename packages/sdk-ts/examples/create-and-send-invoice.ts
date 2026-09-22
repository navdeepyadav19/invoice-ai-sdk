/**
 * Create a customer, invoice them, finalize and email the invoice.
 *
 *   INVOICE_AI_API_KEY=inv_live_… npx tsx examples/create-and-send-invoice.ts
 *
 * Point INVOICE_AI_BASE_URL at a Prism mock or a local server to try it safely:
 *   npx @stoplight/prism-cli mock ../../api-docs/openapi.json
 *   INVOICE_AI_API_KEY=inv_live_test_x INVOICE_AI_BASE_URL=http://127.0.0.1:4010 npx tsx examples/create-and-send-invoice.ts
 */
import InvoiceAI, { InvalidStateError, ValidationError, formatMoney, toMinor } from '@horizonpay/invoice-ai'

const invoiceai = new InvoiceAI() // reads INVOICE_AI_API_KEY

async function main() {
  const customer = await invoiceai.customers.create({ name: 'Acme Industries', email: 'delivered@resend.dev' })

  const draft = await invoiceai.invoices.create({
    customer: customer.id,
    currency: 'USD',
    items: [{ description: 'Consulting retainer — September', quantity: 1, unit_amount: toMinor('2500.00', 'USD') }],
  })

  const invoice = await invoiceai.invoices.finalize(draft.id)
  await invoiceai.invoices.send(invoice.id)
  console.log(`Sent ${invoice.number} for ${formatMoney(invoice.total, invoice.currency)} to ${customer.email}`)

  // Every page of open invoices, fetched lazily.
  for await (const open of invoiceai.invoices.list({ status: 'open' })) {
    console.log(open.number, formatMoney(open.amount_due, open.currency))
  }
}

main().catch((err: unknown) => {
  if (err instanceof ValidationError) console.error('Fix these fields:', err.fields)
  else if (err instanceof InvalidStateError) console.error('Wrong state:', err.detail)
  else console.error(err)
  process.exitCode = 1
})
