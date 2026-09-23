import { describe, expect, it } from 'vitest'
import { ExitCode } from '../src/errors'
import { fakeFetch, harness, invoice, json } from './harness'

const env = { INVOICE_AI_API_KEY: 'inv_live_ab12cd34_x' }

const item = (over: Record<string, unknown> = {}) => ({
  id: 'ii_1',
  object: 'invoiceitem',
  price: 'price_a',
  product: 'prod_1',
  description: 'Design retainer',
  quantity: 2,
  unit: 'NOS',
  unit_amount: 2500,
  amount: 5000,
  discount_percent: 0,
  tax_rate: 0,
  tax_amount: 0,
  ...over,
})

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

describe('invoice-items list / get', () => {
  it('lists the lines of one invoice as a table', async () => {
    const f = fakeFetch(({ url }) => {
      expect(url.pathname).toBe('/api/v1/invoice-items')
      expect(url.searchParams.get('invoice')).toBe('in_1')
      return json({ data: [item(), item({ id: 'ii_2', description: 'Rush fee', price: null })], next_cursor: null })
    })
    const h = harness({ fetch: f, tty: true, env: { ...env, NO_COLOR: '1' } })
    expect(await h.run('invoice-items', 'list', '--invoice', 'in_1')).toBe(0)
    const lines = h.stdout.text.split('\n')
    expect(lines[0]).toMatch(/^ID\s+DESCRIPTION\s+QTY\s+UNIT\s+UNIT AMOUNT\s+TAX %\s+AMOUNT\s+PRICE$/)
    expect(h.stdout.text).toContain('ii_1')
    expect(h.stdout.text).toContain('Rush fee')
  })

  it('list prints JSON when piped', async () => {
    const h = harness({ fetch: fakeFetch(() => json({ data: [item()], next_cursor: null })), env })
    expect(await h.run('invoice-items', 'list', '--invoice', 'in_1')).toBe(0)
    expect(JSON.parse(h.stdout.text).data).toEqual([item()])
  })

  it('list requires --invoice (exit 2, no request)', async () => {
    const f = fakeFetch(() => json({}))
    const h = harness({ fetch: f, env })
    expect(await h.run('invoice-items', 'list')).toBe(ExitCode.USAGE)
    expect(h.stderr.text).toContain('--invoice')
    expect(f.calls).toHaveLength(0)
  })

  it('get retrieves one line', async () => {
    const f = fakeFetch(() => json({ data: item() }))
    const h = harness({ fetch: f, env })
    expect(await h.run('invoice-items', 'get', 'ii_1')).toBe(0)
    expect(f.calls[0]!.url.pathname).toBe('/api/v1/invoice-items/ii_1')
    expect(JSON.parse(h.stdout.text)).toEqual(item())
  })
})

describe('invoice-items create', () => {
  it('adds a priced line and prints the recomputed invoice', async () => {
    const f = fakeFetch(() => json({ data: invoice({ total: 12500 }) }, 201))
    const h = harness({ fetch: f, env })
    expect(
      await h.run('invoice-items', 'create', '--invoice', 'in_1', '--price', 'price_a', '--qty', '2.5', '--tax-rate', '18'),
    ).toBe(0)
    const call = f.calls[0]!
    expect([call.method, call.url.pathname]).toEqual(['POST', '/api/v1/invoice-items'])
    expect(JSON.parse(call.body)).toEqual({ invoice: 'in_1', price: 'price_a', quantity: 2.5, tax_rate: 18 })
    expect(call.headers.get('idempotency-key')).toBeTruthy()
    expect(JSON.parse(h.stdout.text)).toMatchObject({ id: 'in_1', total: 12500 })
    expect(h.stderr.text).toContain('Added a line to in_1')
  })

  it('converts --amount with the invoice currency (looked up when --currency is absent)', async () => {
    const f = fakeFetch(({ method, url }) => {
      if (method === 'GET' && url.pathname === '/api/v1/invoices/in_1') return json({ data: invoice({ currency: 'JPY' }) })
      return json({ data: invoice({ currency: 'JPY' }) }, 201)
    })
    const h = harness({ fetch: f, env })
    expect(
      await h.run('invoice-items', 'create', '--invoice', 'in_1', '--description', 'Rush fee', '--amount', '5000', '--unit', 'HRS', '--discount', '10'),
    ).toBe(0)
    expect(f.calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual(['GET /api/v1/invoices/in_1', 'POST /api/v1/invoice-items'])
    expect(JSON.parse(f.calls[1]!.body)).toEqual({
      invoice: 'in_1',
      description: 'Rush fee',
      unit: 'HRS',
      discount_percent: 10,
      unit_amount: 5000, // JPY has no minor unit
    })
  })

  it('--currency skips the invoice lookup', async () => {
    const f = fakeFetch(() => json({ data: invoice() }, 201))
    const h = harness({ fetch: f, env })
    expect(
      await h.run('invoice-items', 'create', '--invoice', 'in_1', '--description', 'Setup', '--amount', '25.50', '--currency', 'usd'),
    ).toBe(0)
    expect(f.calls).toHaveLength(1)
    expect(JSON.parse(f.calls[0]!.body)).toMatchObject({ unit_amount: 2550 })
  })

  it('merges --data with flags (flags win)', async () => {
    const f = fakeFetch(() => json({ data: invoice() }, 201))
    const h = harness({ fetch: f, env })
    expect(
      await h.run('invoice-items', 'create', '--data', '{"invoice":"in_old","description":"X","unit_amount":100}', '--invoice', 'in_1'),
    ).toBe(0)
    expect(JSON.parse(f.calls[0]!.body)).toEqual({ invoice: 'in_1', description: 'X', unit_amount: 100 })
  })

  it.each([
    [['--price', 'price_a'], 'Which invoice?'],
    [['--invoice', 'in_1', '--description', 'Only text'], 'needs a --price'],
    [['--invoice', 'in_1', '--amount', '5', '--unit-amount', '500', '--description', 'x'], 'not both'],
    [['--invoice', 'in_1', '--price', 'price_a', '--tax-rate', '101'], 'percentage'],
    [['--invoice', 'in_1', '--price', 'price_a', '--qty', '0'], 'positive number'],
    [['--invoice', 'in_1', '--price', 'price_a', '--unit', 'XYZ'], 'XYZ'],
  ])('rejects %j (exit 2, no request)', async (args, message) => {
    const f = fakeFetch(() => json({ data: invoice() }))
    const h = harness({ fetch: f, env })
    expect(await h.run('invoice-items', 'create', ...args)).toBe(ExitCode.USAGE)
    expect(h.stderr.text).toContain(message)
    expect(f.calls).toHaveLength(0)
  })
})

describe('invoice-items delete', () => {
  it('refuses without --yes when not in a terminal', async () => {
    const f = fakeFetch(() => json({ data: invoice() }))
    const h = harness({ fetch: f, env })
    expect(await h.run('invoice-items', 'delete', 'ii_1')).toBe(ExitCode.USAGE)
    expect(f.calls).toHaveLength(0)
  })

  it('--yes removes the line, scoped to --invoice, and prints the invoice', async () => {
    const f = fakeFetch(() => json({ data: invoice({ total: 2500 }) }))
    const h = harness({ fetch: f, env })
    expect(await h.run('invoice-items', 'delete', 'ii_1', '--invoice', 'in_1', '--yes')).toBe(0)
    const call = f.calls[0]!
    expect([call.method, call.url.pathname, call.url.searchParams.get('invoice')]).toEqual([
      'DELETE',
      '/api/v1/invoice-items/ii_1',
      'in_1',
    ])
    expect(JSON.parse(h.stdout.text)).toMatchObject({ id: 'in_1', total: 2500 })
    expect(h.stderr.text).toContain('Removed line ii_1')
  })

  it('surfaces the API 409 for the last line (exit 1)', async () => {
    const f = fakeFetch(
      () =>
        new Response(
          JSON.stringify({ type: 'about:blank', title: 'invalid_state', status: 409, code: 'invalid_state', detail: 'A draft keeps at least one line.' }),
          { status: 409, headers: { 'content-type': 'application/problem+json' } },
        ),
    )
    const h = harness({ fetch: f, env })
    expect(await h.run('invoice-items', 'delete', 'ii_1', '--yes')).toBe(ExitCode.API)
    expect(h.stderr.text).toContain('at least one line')
  })
})

describe('prices update', () => {
  it('sends only the fields passed', async () => {
    const f = fakeFetch(() => json({ data: price({ nickname: 'Annual', tax_rate: 18 }) }))
    const h = harness({ fetch: f, env })
    expect(await h.run('prices', 'update', 'price_a', '--nickname', 'Annual', '--tax-rate', '18')).toBe(0)
    const call = f.calls[0]!
    expect([call.method, call.url.pathname]).toEqual(['PATCH', '/api/v1/prices/price_a'])
    expect(JSON.parse(call.body)).toEqual({ nickname: 'Annual', tax_rate: 18 })
    expect(JSON.parse(h.stdout.text)).toMatchObject({ nickname: 'Annual', tax_rate: 18 })
    expect(h.stderr.text).toContain('Updated price price_a')
  })

  it('--nickname "" clears the nickname; --data fills other fields', async () => {
    const f = fakeFetch(() => json({ data: price() }))
    const h = harness({ fetch: f, env })
    expect(await h.run('prices', 'update', 'price_a', '--nickname', '', '--data', '{"active":true}')).toBe(0)
    expect(JSON.parse(f.calls[0]!.body)).toEqual({ active: true, nickname: '' })
  })

  it('needs at least one field (exit 2)', async () => {
    const f = fakeFetch(() => json({ data: price() }))
    const h = harness({ fetch: f, env })
    expect(await h.run('prices', 'update', 'price_a')).toBe(ExitCode.USAGE)
    expect(h.stderr.text).toContain('Nothing to update')
    expect(f.calls).toHaveLength(0)
  })

  it('rejects a tax rate outside 0-100 (exit 2)', async () => {
    const h = harness({ env })
    expect(await h.run('prices', 'update', 'price_a', '--tax-rate', '150')).toBe(ExitCode.USAGE)
  })
})
