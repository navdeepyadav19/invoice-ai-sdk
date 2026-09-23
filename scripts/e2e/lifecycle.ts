/**
 * Live end-to-end lifecycle through the TypeScript SDK (opt-in; never runs on PRs).
 *
 *   INVOICE_AI_E2E_KEY=inv_live_… pnpm exec tsx scripts/e2e/lifecycle.ts
 *
 * customer → product + USD price → invoice (with the price) → finalize → send
 * (to delivered@resend.dev) → pay; a second invoice → finalize → void; then
 * archive the price, product and customer. Prints a compact summary and exits
 * non-zero on any failure. Cleanup (archiving) runs even when a step fails.
 *
 * Env:
 *   INVOICE_AI_E2E_KEY     API key of the QA account (required)
 *   INVOICE_AI_BASE_URL    API base URL (default: production)
 *   INVOICE_AI_E2E_MOCK=1  running against a Prism mock: its responses are
 *                          static examples, so only response shapes are checked,
 *                          not state transitions (status, ids echoed back)
 *
 * Imports the SDK from source, so it needs no build and runs anywhere tsx does.
 */
import { InvoiceAI } from '../../packages/sdk-ts/src/index'

const RECIPIENT = 'delivered@resend.dev'
const MOCK = process.env.INVOICE_AI_E2E_MOCK === '1'

type Step = { name: string; ok: boolean; ms: number; detail: string }
const steps: Step[] = []
/** Errors a step already recorded as its own failure (vs. a failed assertion after it). */
const recorded = new WeakSet<object>()

async function step<T>(name: string, fn: () => Promise<T>, describe: (r: T) => string = () => ''): Promise<T> {
  const start = Date.now()
  try {
    const result = await fn()
    steps.push({ name, ok: true, ms: Date.now() - start, detail: describe(result) })
    return result
  } catch (err) {
    const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
    steps.push({ name, ok: false, ms: Date.now() - start, detail })
    if (err && typeof err === 'object') recorded.add(err)
    throw err
  }
}

function expect(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${message}`)
}

/** A state assertion: skipped against a mock, whose responses never change. */
function expectState(cond: unknown, message: string): void {
  if (!MOCK) expect(cond, message)
}

function printSummary(runId: string, baseURL: string): boolean {
  const failed = steps.filter((s) => !s.ok).length
  const width = Math.max(...steps.map((s) => s.name.length))
  console.log(`\nInvoice-AI e2e (TypeScript SDK) run ${runId} against ${baseURL}${MOCK ? ' [mock]' : ''}`)
  for (const s of steps) {
    console.log(`  ${s.ok ? 'ok  ' : 'FAIL'}  ${s.name.padEnd(width)}  ${String(s.ms).padStart(5)} ms  ${s.detail}`)
  }
  console.log(failed ? `\n${failed} step(s) failed.` : `\nAll ${steps.length} steps passed.`)
  return failed === 0
}

async function main(): Promise<number> {
  const apiKey = process.env.INVOICE_AI_E2E_KEY
  if (!apiKey) {
    console.error('INVOICE_AI_E2E_KEY is not set; nothing to do.')
    return 2
  }
  const client = new InvoiceAI({ apiKey, baseURL: process.env.INVOICE_AI_BASE_URL || undefined, maxRetries: 2 })
  const runId = `e2e-ts-${new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15)}-${Math.random().toString(36).slice(2, 6)}`

  const created: { customer?: string; product?: string; price?: string } = {}
  let failure: unknown
  try {
    const customer = await step(
      'customers.create',
      () => client.customers.create({ name: `E2E ${runId}`, email: RECIPIENT }),
      (c) => c.id,
    )
    created.customer = customer.id
    expect(customer.id.startsWith('cus_'), `customer id ${customer.id}`)

    const product = await step('products.create', () => client.products.create({ name: `E2E product ${runId}` }), (p) => p.id)
    created.product = product.id
    expect(product.id.startsWith('prod_'), `product id ${product.id}`)

    const price = await step(
      'prices.create',
      () => client.prices.create({ product: product.id, unit_amount: 12_345, currency: 'USD', nickname: runId }),
      (p) => `${p.id} ${p.unit_amount} ${p.currency}`,
    )
    created.price = price.id
    expect(price.id.startsWith('price_'), `price id ${price.id}`)
    expectState(price.unit_amount === 12_345 && price.currency === 'USD', 'price echoes unit_amount and currency')

    // Invoice 1: finalize → send → pay.
    const inv = await step(
      'invoices.create #1',
      () => client.invoices.create({ customer: customer.id, currency: 'USD', items: [{ price: price.id, quantity: 2 }] }),
      (i) => `${i.id} ${i.status} total=${i.total}`,
    )
    expect(inv.id.startsWith('in_'), `invoice id ${inv.id}`)
    expectState(inv.status === 'draft', `new invoice is draft, got ${inv.status}`)
    expectState(inv.total === 24_690, `total is 2 × 12345 = 24690, got ${inv.total}`)

    const fin = await step('invoices.finalize #1', () => client.invoices.finalize(inv.id), (i) => `${i.number} ${i.status}`)
    expect(typeof fin.number === 'string' && fin.number.length > 0, 'finalized invoice has a number')
    expectState(fin.status === 'open', `finalized invoice is open, got ${fin.status}`)

    const sent = await step('invoices.send #1', () => client.invoices.send(inv.id, { to: RECIPIENT }), (r) => `emailed_to=${r.emailed_to}`)
    expectState(sent.emailed_to === RECIPIENT, `emailed_to ${sent.emailed_to}`)

    const paid = await step(
      'invoices.pay #1',
      () => client.invoices.pay(inv.id, { reference: runId }),
      (i) => `${i.status} amount_due=${i.amount_due}`,
    )
    expectState(paid.status === 'paid' && paid.amount_due === 0, `paid invoice, got ${paid.status} / ${paid.amount_due}`)

    // Invoice 2: finalize → void.
    const inv2 = await step(
      'invoices.create #2',
      () => client.invoices.create({ customer: customer.id, currency: 'USD', items: [{ price: price.id }] }),
      (i) => `${i.id} ${i.status}`,
    )
    expect(inv2.id.startsWith('in_'), `invoice id ${inv2.id}`)
    await step('invoices.finalize #2', () => client.invoices.finalize(inv2.id), (i) => `${i.number} ${i.status}`)
    const voided = await step(
      'invoices.void #2',
      () => client.invoices.void(inv2.id, { reason: `E2E run ${runId}` }),
      (i) => `${i.status}`,
    )
    expectState(voided.status === 'void', `voided invoice, got ${voided.status}`)
  } catch (err) {
    failure = err
    if (!(err && typeof err === 'object' && recorded.has(err))) {
      // An assertion on the previous step's response, not a failed request.
      steps.push({ name: `  check after ${steps.at(-1)?.name ?? 'start'}`, ok: false, ms: 0, detail: err instanceof Error ? err.message : String(err) })
    }
  } finally {
    // Archive whatever was created, even after a failure, so the QA account stays tidy.
    if (created.price) await step('prices.archive', () => client.prices.archive(created.price!), (p) => `active=${p.active}`).catch(() => {})
    if (created.product) await step('products.archive', () => client.products.archive(created.product!), (p) => `active=${p.active}`).catch(() => {})
    if (created.customer) await step('customers.del (archive)', () => client.customers.del(created.customer!), (c) => `deleted=${c.deleted}`).catch(() => {})
  }

  const ok = printSummary(runId, client.baseURL)
  if (failure) console.error(`\nFirst failure: ${failure instanceof Error ? (failure.stack ?? failure.message) : String(failure)}`)
  return ok && !failure ? 0 : 1
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err)
    process.exit(1)
  },
)
