import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ExitCode } from '../src/errors'
import { customer, fakeFetch, harness, invoice, json, type Handler } from './harness'

/**
 * `invoice-ai invoices create` (the wizard), driven with scripted answers.
 *
 * @clack/prompts is replaced by a fake whose text/select/confirm pop the next
 * answer off a script and record the prompt they were asked with, so each
 * test reads as the conversation a user would have.
 */

type Kind = 'text' | 'select' | 'confirm'
interface Step {
  kind: Kind
  answer: unknown
  /** Substring the prompt's message must contain. */
  message?: string
}

const CANCEL = Symbol('clack:cancel')

const prompts = vi.hoisted(() => ({
  script: [] as { kind: string; answer: unknown; message?: string }[],
  asked: [] as { kind: string; message: string; options?: { value: unknown; label?: string; hint?: string }[] }[],
  logs: [] as string[],
}))

vi.mock('@clack/prompts', () => {
  const next = (kind: string) => async (opts: { message: string; options?: { value: unknown; label?: string; hint?: string }[] }) => {
    prompts.asked.push({ kind, message: opts.message, ...(opts.options ? { options: opts.options } : {}) })
    const step = prompts.script.shift()
    if (!step) throw new Error(`Unscripted ${kind} prompt: "${opts.message}"`)
    if (step.kind !== kind) throw new Error(`Expected a ${step.kind} prompt, got ${kind}: "${opts.message}"`)
    if (step.message && !opts.message.includes(step.message)) {
      throw new Error(`Expected prompt "${step.message}", got "${opts.message}"`)
    }
    return step.answer
  }
  const log = (s: string) => prompts.logs.push(s)
  return {
    text: next('text'),
    select: next('select'),
    confirm: next('confirm'),
    isCancel: (v: unknown) => typeof v === 'symbol',
    intro: log,
    outro: log,
    cancel: log,
    note: (body: string, title?: string) => log(`${title ?? ''}\n${body}`),
    spinner: () => ({ start: () => undefined, stop: (s?: string) => s && log(s), message: () => undefined }),
    log: { warn: log, success: log, info: log, error: log, message: log, step: log },
  }
})

const env = { INVOICE_AI_API_KEY: 'inv_live_ab12cd34_x', NO_COLOR: '1' }

const price = (over: Record<string, unknown> = {}) => ({
  id: 'price_a',
  object: 'price',
  product: 'prod_1',
  nickname: null,
  unit_amount: 2500,
  currency: 'USD',
  type: 'one_time',
  recurring: null,
  tax_rate: 0,
  active: true,
  created: '2026-09-01T12:00:00Z',
  ...over,
})

const product = { id: 'prod_1', object: 'product', name: 'Design retainer', description: null, active: true, created: '2026-09-01T12:00:00Z' }

/** A fake API with one customer (or `customers`), two prices and one product. */
function api(opts: { customers?: ReturnType<typeof customer>[] } = {}): ReturnType<typeof fakeFetch> {
  const customers = opts.customers ?? [customer()]
  const handler: Handler = ({ method, url }) => {
    const route = `${method} ${url.pathname}`
    switch (route) {
      case 'GET /api/v1/customers':
        return json({ data: customers, next_cursor: null })
      case 'GET /api/v1/prices':
        return json({ data: [price(), price({ id: 'price_eur', currency: 'EUR', nickname: 'Europe' })], next_cursor: null })
      case 'GET /api/v1/products':
        return json({ data: [product], next_cursor: null })
      case 'POST /api/v1/invoices':
        return json({ data: invoice({ total: 7500 }) }, 201)
      case 'POST /api/v1/invoices/in_1/finalize':
        return json({ data: invoice({ status: 'open', number: 'INV-0007', total: 7500 }) })
      case 'POST /api/v1/invoices/in_1/send':
        return json({ data: invoice({ status: 'open', number: 'INV-0007', total: 7500 }), emailed_to: 'ap@acme.example' })
      default:
        return json({ error: `unexpected ${route}` }, 404)
    }
  }
  return fakeFetch(handler)
}

const routes = (f: ReturnType<typeof fakeFetch>) => f.calls.map((c) => `${c.method} ${c.url.pathname}`)

/** Search "acme" → Acme Corp → Design retainer × 3 → no more lines → create. */
const toDraft: Step[] = [
  { kind: 'text', message: 'Search customers', answer: 'acme' },
  { kind: 'select', message: 'Bill to', answer: 'cus_A1' },
  { kind: 'select', message: 'Add a line', answer: 'price_a' },
  { kind: 'text', message: 'Quantity', answer: '3' },
  { kind: 'confirm', message: 'Add another line?', answer: false },
  { kind: 'confirm', message: 'Create this draft invoice?', answer: true },
]

async function runWizard(steps: Step[], f = api()) {
  prompts.script.push(...steps)
  const h = harness({ fetch: f, env, tty: true })
  const code = await h.run('invoices', 'create')
  return { h, f, code }
}

beforeEach(() => {
  prompts.script.length = 0
  prompts.asked.length = 0
  prompts.logs.length = 0
})

describe('invoices create wizard', () => {
  it('search customer → pick price → quantity → confirm creates a draft', async () => {
    const { f, code } = await runWizard([...toDraft, { kind: 'select', message: 'What next?', answer: 'draft' }])
    expect(code).toBe(0)
    expect(prompts.script).toHaveLength(0) // every scripted answer was used

    const search = f.calls.find((c) => c.url.pathname === '/api/v1/customers')!
    expect(search.url.searchParams.get('query')).toBe('acme')
    expect(f.calls.find((c) => c.url.pathname === '/api/v1/prices')!.url.searchParams.get('active')).toBe('true')

    const create = f.calls.find((c) => c.method === 'POST')!
    expect(create.url.pathname).toBe('/api/v1/invoices')
    expect(JSON.parse(create.body)).toEqual({ customer: 'cus_A1', currency: 'USD', items: [{ price: 'price_a', quantity: 3 }] })
    expect(routes(f).filter((r) => r.startsWith('POST'))).toEqual(['POST /api/v1/invoices'])

    // The price picker labels lines by product name and shows the amount.
    const picker = prompts.asked.find((a) => a.message === 'Add a line')!
    expect(picker.options).toContainEqual({ value: 'price_a', label: 'Design retainer', hint: '$25.00' })
    // The review shows the estimated subtotal: 3 × $25.00.
    expect(prompts.logs.find((l) => l.startsWith('Review'))).toContain('$75.00')
    expect(prompts.logs.some((l) => l.includes('Created draft in_1'))).toBe(true)
  })

  it('finalize and send: shows the recipient, then sends', async () => {
    const { f, code } = await runWizard([
      ...toDraft,
      { kind: 'select', message: 'What next?', answer: 'send' },
      { kind: 'confirm', message: 'Email it to ap@acme.example?', answer: true },
    ])
    expect(code).toBe(0)
    expect(routes(f).filter((r) => r.startsWith('POST'))).toEqual(['POST /api/v1/invoices', 'POST /api/v1/invoices/in_1/send'])
    expect(prompts.logs.some((l) => l.includes('Sent INV-0007 to ap@acme.example'))).toBe(true)
  })

  it('finalize only', async () => {
    const { f, code } = await runWizard([...toDraft, { kind: 'select', message: 'What next?', answer: 'finalize' }])
    expect(code).toBe(0)
    expect(routes(f).filter((r) => r.startsWith('POST'))).toEqual(['POST /api/v1/invoices', 'POST /api/v1/invoices/in_1/finalize'])
    expect(prompts.logs.some((l) => l.includes('Finalized as INV-0007'))).toBe(true)
  })

  it('send without an email on file falls back to finalize', async () => {
    const f = api({ customers: [customer({ email: null })] })
    const { code } = await runWizard([...toDraft, { kind: 'select', message: 'What next?', answer: 'send' }], f)
    expect(code).toBe(0)
    expect(routes(f).filter((r) => r.startsWith('POST'))).toEqual(['POST /api/v1/invoices', 'POST /api/v1/invoices/in_1/finalize'])
    expect(prompts.logs.some((l) => l.includes('no email on file'))).toBe(true)
  })

  it('declining the send confirmation leaves a draft', async () => {
    const { f, code } = await runWizard([
      ...toDraft,
      { kind: 'select', message: 'What next?', answer: 'send' },
      { kind: 'confirm', message: 'Email it', answer: false },
    ])
    expect(code).toBe(0)
    expect(routes(f).filter((r) => r.startsWith('POST'))).toEqual(['POST /api/v1/invoices'])
  })

  it('"Search again" re-runs the search; later lines only offer the first line\'s currency', async () => {
    const { f, code } = await runWizard([
      { kind: 'text', message: 'Search customers', answer: 'acm' },
      { kind: 'select', message: 'Bill to', answer: '__search__' },
      { kind: 'text', message: 'Search customers', answer: 'acme' },
      { kind: 'select', message: 'Bill to', answer: 'cus_A1' },
      { kind: 'select', message: 'Add a line', answer: 'price_a' },
      { kind: 'text', message: 'Quantity', answer: '' }, // Enter → default 1
      { kind: 'confirm', message: 'Add another line?', answer: true },
      { kind: 'select', message: 'Add another line', answer: 'price_a' },
      { kind: 'text', message: 'Quantity', answer: '2' },
      { kind: 'confirm', message: 'Add another line?', answer: false },
      { kind: 'confirm', message: 'Create this draft invoice?', answer: true },
      { kind: 'select', message: 'What next?', answer: 'draft' },
    ])
    expect(code).toBe(0)
    const searches = f.calls.filter((c) => c.url.pathname === '/api/v1/customers').map((c) => c.url.searchParams.get('query'))
    expect(searches).toEqual(['acm', 'acme'])
    const second = prompts.asked.find((a) => a.message === 'Add another line' && a.kind === 'select')!
    expect(second.options!.map((o) => o.value)).toEqual(['price_a']) // EUR price filtered out
    const create = f.calls.find((c) => c.method === 'POST')!
    expect(JSON.parse(create.body).items).toEqual([
      { price: 'price_a', quantity: 1 },
      { price: 'price_a', quantity: 2 },
    ])
  })

  it('answering "no" at review creates nothing (exit 0)', async () => {
    const steps = toDraft.slice(0, -1)
    const { f, code } = await runWizard([...steps, { kind: 'confirm', message: 'Create this draft invoice?', answer: false }])
    expect(code).toBe(0)
    expect(f.calls.some((c) => c.method === 'POST')).toBe(false)
    expect(prompts.logs).toContain('Nothing was created.')
  })

  it('Ctrl-C at any prompt cancels without creating anything (exit 1)', async () => {
    const { f, code } = await runWizard([
      { kind: 'text', message: 'Search customers', answer: 'acme' },
      { kind: 'select', message: 'Bill to', answer: CANCEL },
    ])
    expect(code).toBe(ExitCode.API)
    expect(f.calls.some((c) => c.method === 'POST')).toBe(false)
    expect(prompts.logs).toContain('Cancelled. Nothing was created.')
  })

  it('with no customers at all, stops with a hint (exit 2)', async () => {
    const f = api({ customers: [] })
    const { h, code } = await runWizard([{ kind: 'text', message: 'Search customers', answer: '' }], f)
    expect(code).toBe(ExitCode.USAGE)
    expect(h.stderr.text).toContain('customers create')
  })
})
