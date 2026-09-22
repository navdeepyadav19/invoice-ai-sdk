/**
 * Contract test: every SDK method against a Prism mock of api-docs/openapi.json.
 *
 *   pnpm --filter @horizonpay/invoice-ai test:contract
 *
 * Prism validates each request against the spec and reports problems in the
 * `sl-violations` response header, so this catches the SDK sending a path,
 * query, header or body the API wouldn't accept. Responses come from the
 * spec's examples and must parse into the shape the SDK promises.
 *
 * If Prism can't be downloaded or started (offline CI, no npx), the tests skip.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { InvoiceAI, OPERATIONS, Page, type OperationId } from '../../src/index'

const SPEC = fileURLToPath(new URL('../../../../api-docs/openapi.json', import.meta.url))
const KEY = 'inv_live_ab12cd34_contractTestKey'

let prism: ChildProcess | undefined
let baseURL: string | undefined
let prismExited = false
const violations: string[] = []

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      srv.close(() => resolve(typeof addr === 'object' && addr ? addr.port : 4010))
    })
  })
}

async function waitForPrism(url: string, deadline: number): Promise<boolean> {
  while (Date.now() < deadline) {
    if (prismExited) return false
    try {
      await fetch(`${url}/business`)
      return true // any HTTP answer means it's listening
    } catch {
      await new Promise((r) => setTimeout(r, 500))
    }
  }
  return false
}

beforeAll(async () => {
  const port = await freePort()
  try {
    prism = spawn(
      'npx',
      ['--yes', '@stoplight/prism-cli@5', 'mock', '--host', '127.0.0.1', '--port', String(port), '--errors', SPEC],
      { stdio: 'ignore', shell: process.platform === 'win32' },
    )
    prism.on('error', () => (prismExited = true))
    prism.on('exit', () => (prismExited = true))
  } catch {
    return
  }
  const url = `http://127.0.0.1:${port}`
  if (await waitForPrism(url, Date.now() + 150_000)) baseURL = url
  else console.warn('[contract] Prism did not start; skipping contract tests.')
}, 180_000)

afterAll(() => {
  prism?.kill()
})

function sdk(): InvoiceAI {
  // A fetch that records Prism's validation verdict for every request.
  const recordingFetch: typeof fetch = async (input, init) => {
    const res = await fetch(input, init)
    const v = res.headers.get('sl-violations')
    if (v) violations.push(`${init?.method ?? 'GET'} ${String(input)}: ${v}`)
    return res
  }
  return new InvoiceAI({ apiKey: KEY, baseURL, fetch: recordingFetch, maxRetries: 0, timeout: 15_000 })
}

type Call = (c: InvoiceAI) => PromiseLike<unknown>

/** One representative call per operation. A new operation fails the "has a call" test until added here. */
const CALLS: Record<OperationId, Call> = {
  getBusiness: (c) => c.business.retrieve(),
  listCustomers: (c) => c.customers.list({ limit: 2, query: 'acme' }),
  createCustomer: (c) => c.customers.create({ name: 'Acme Industries', email: 'ap@acme.example' }),
  retrieveCustomer: (c) => c.customers.retrieve('cus_Nf3kQ8pR2mX7vB1cT9wL4sZ6'),
  updateCustomer: (c) => c.customers.update('cus_Nf3kQ8pR2mX7vB1cT9wL4sZ6', { phone: '+1 512 555 0100' }),
  deleteCustomer: (c) => c.customers.del('cus_Nf3kQ8pR2mX7vB1cT9wL4sZ6'),
  listProducts: (c) => c.products.list({ active: true }),
  createProduct: (c) => c.products.create({ name: 'Consulting retainer' }),
  retrieveProduct: (c) => c.products.retrieve('prod_Hy7Rq2Lm9Xc4Vb8Nt3Kd6Pw1'),
  updateProduct: (c) => c.products.update('prod_Hy7Rq2Lm9Xc4Vb8Nt3Kd6Pw1', { name: 'Retainer' }),
  archiveProduct: (c) => c.products.archive('prod_Hy7Rq2Lm9Xc4Vb8Nt3Kd6Pw1'),
  listPrices: (c) => c.prices.list({ product: 'prod_Hy7Rq2Lm9Xc4Vb8Nt3Kd6Pw1', currency: 'USD' }),
  createPrice: (c) =>
    c.prices.create({ product: 'prod_Hy7Rq2Lm9Xc4Vb8Nt3Kd6Pw1', currency: 'USD', unit_amount: 250000 }),
  retrievePrice: (c) => c.prices.retrieve('price_Jc5Tn8Wq1Ze6Ra3Ym9Ub2Gs7'),
  updatePrice: (c) => c.prices.update('price_Jc5Tn8Wq1Ze6Ra3Ym9Ub2Gs7', { active: false }),
  archivePrice: (c) => c.prices.archive('price_Jc5Tn8Wq1Ze6Ra3Ym9Ub2Gs7'),
  listInvoices: (c) => c.invoices.list({ status: 'open', limit: 5 }),
  createInvoice: (c) =>
    c.invoices.create({
      customer: 'cus_Nf3kQ8pR2mX7vB1cT9wL4sZ6',
      items: [{ price: 'price_Jc5Tn8Wq1Ze6Ra3Ym9Ub2Gs7', quantity: 1 }],
    }),
  retrieveInvoice: (c) => c.invoices.retrieve('in_Pb2Xk7Mv4Qs9Lr1Wd6Tn3Fh8'),
  updateInvoice: (c) =>
    c.invoices.update('in_Pb2Xk7Mv4Qs9Lr1Wd6Tn3Fh8', {
      customer: 'cus_Nf3kQ8pR2mX7vB1cT9wL4sZ6',
      description: 'September retainer',
    }),
  deleteInvoice: (c) => c.invoices.del('in_Pb2Xk7Mv4Qs9Lr1Wd6Tn3Fh8'),
  finalizeInvoice: (c) => c.invoices.finalize('in_Pb2Xk7Mv4Qs9Lr1Wd6Tn3Fh8'),
  sendInvoice: (c) => c.invoices.send('in_Pb2Xk7Mv4Qs9Lr1Wd6Tn3Fh8', {}),
  payInvoice: (c) => c.invoices.pay('in_Pb2Xk7Mv4Qs9Lr1Wd6Tn3Fh8', {}),
  voidInvoice: (c) => c.invoices.void('in_Pb2Xk7Mv4Qs9Lr1Wd6Tn3Fh8', { reason: 'Duplicate' }),
  retrieveInvoicePdf: (c) => c.invoices.pdf('in_Pb2Xk7Mv4Qs9Lr1Wd6Tn3Fh8'),
  listInvoiceEvents: (c) => c.invoices.events('in_Pb2Xk7Mv4Qs9Lr1Wd6Tn3Fh8'),
  listInvoiceItems: (c) => c.invoiceItems.list({ invoice: 'in_Pb2Xk7Mv4Qs9Lr1Wd6Tn3Fh8' }),
  createInvoiceItem: (c) =>
    c.invoiceItems.create({
      invoice: 'in_Pb2Xk7Mv4Qs9Lr1Wd6Tn3Fh8',
      description: 'Onboarding workshop',
      unit_amount: 50000,
    }),
  retrieveInvoiceItem: (c) => c.invoiceItems.retrieve('ii_Da4Vq9Ns2Kx7Bm3Yt8Rc1Lp6'),
  deleteInvoiceItem: (c) => c.invoiceItems.del('ii_Da4Vq9Ns2Kx7Bm3Yt8Rc1Lp6', { invoice: 'in_Pb2Xk7Mv4Qs9Lr1Wd6Tn3Fh8' }),
  listWebhookEndpoints: (c) => c.webhookEndpoints.list(),
  createWebhookEndpoint: (c) =>
    c.webhookEndpoints.create({ url: 'https://example.com/hooks/invoice-ai', events: ['invoice.paid'] }),
  deleteWebhookEndpoint: (c) => c.webhookEndpoints.del('4f9c2a1e-7b3d-4e8a-9c6f-2d1b0a3e5f71'),
}

describe('contract (Prism mock of openapi.json)', () => {
  it('has a call for every operation', () => {
    expect(Object.keys(CALLS).sort()).toEqual(OPERATIONS.map((o) => o.operationId).sort())
  })

  for (const op of OPERATIONS) {
    it(op.operationId, async (ctx) => {
      if (!baseURL) return ctx.skip()
      const before = violations.length
      const result = await CALLS[op.operationId](sdk())
      expect(violations.slice(before), 'Prism reported request violations').toEqual([])

      switch (op.kind as string) {
        case 'page':
          expect(result).toBeInstanceOf(Page)
          expect(Array.isArray((result as Page<unknown>).data)).toBe(true)
          break
        case 'data':
          expect(result).toBeTypeOf('object')
          expect(result).not.toHaveProperty('data') // unwrapped
          break
        case 'body':
          expect(result).toHaveProperty('data')
          break
        case 'binary':
          expect(result).toBeInstanceOf(ArrayBuffer)
          break
        case 'void':
          expect(result).toBeUndefined()
          break
      }
    })
  }
})
