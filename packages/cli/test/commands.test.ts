import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { constructEvent } from '@horizonpay/invoice-ai'
import { buildSignedTestEvent } from '../src/commands/webhooks'
import { DOCS_BASE_URL } from '../src/constants'
import { parseQueryPairs } from '../src/util/parse'
import { checkForUpdate, isNewer } from '../src/util/update-notifier'
import { customer, fakeFetch, harness, invoice, json } from './harness'

const env = { INVOICE_AI_API_KEY: 'inv_live_ab12cd34_x' }

describe('invoices create (flags)', () => {
  it('builds items from --price/--qty, then finalizes and sends with --send', async () => {
    const f = fakeFetch(({ method, url }) => {
      if (method === 'POST' && url.pathname === '/api/v1/invoices') return json({ data: invoice() }, 201)
      if (url.pathname === '/api/v1/invoices/in_1/send') {
        return json({ data: invoice({ status: 'open', number: 'INV-0042' }), emailed_to: 'ap@acme.example' })
      }
      return json({}, 404)
    })
    const h = harness({ fetch: f, env })
    const code = await h.run(
      'invoices', 'create', '--customer', 'cus_A1', '--price', 'price_a', '--qty', '2', '--price', 'price_b',
      '--currency', 'usd', '--due-date', '2026-10-31', '--send',
    )
    expect(code).toBe(0)
    const create = f.calls[0]!
    expect(JSON.parse(create.body)).toEqual({
      customer: 'cus_A1',
      currency: 'USD',
      due_date: '2026-10-31',
      items: [
        { price: 'price_a', quantity: 2 },
        { price: 'price_b', quantity: 1 },
      ],
    })
    // The SDK adds an Idempotency-Key to every POST.
    expect(create.headers.get('idempotency-key')).toMatch(/[0-9a-f-]{36}/)
    expect(f.calls[1]!.url.pathname).toBe('/api/v1/invoices/in_1/send')
    expect(JSON.parse(h.stdout.text)).toMatchObject({ id: 'in_1', number: 'INV-0042', status: 'open' })
    expect(h.stderr.text).toContain('Sent INV-0042 to ap@acme.example')
  })

  it('merges --data with flags (flags win)', async () => {
    const f = fakeFetch(() => json({ data: invoice() }, 201))
    const h = harness({ fetch: f, env })
    expect(
      await h.run('invoices', 'create', '--data', '{"customer":"cus_old","footer":"Thanks"}', '--customer', 'cus_new'),
    ).toBe(0)
    expect(JSON.parse(f.calls[0]!.body)).toEqual({ customer: 'cus_new', footer: 'Thanks' })
  })

  it('requires a customer (exit 2)', async () => {
    const h = harness({ env })
    expect(await h.run('invoices', 'create', '--price', 'price_a')).toBe(2)
    expect(h.stderr.text).toContain('needs a customer')
  })
})

describe('invoices send / pdf', () => {
  it('send shows the recipient before sending', async () => {
    const f = fakeFetch(({ url }) => {
      if (url.pathname === '/api/v1/invoices/in_1') return json({ data: invoice() })
      if (url.pathname === '/api/v1/customers/cus_A1') return json({ data: customer() })
      return json({ data: invoice({ status: 'open' }), emailed_to: 'ap@acme.example' })
    })
    const h = harness({ fetch: f, env })
    expect(await h.run('invoices', 'send', 'in_1', '--yes')).toBe(0)
    expect(h.stderr.text).toContain('Recipient: ap@acme.example')
    expect(f.calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual([
      'GET /api/v1/invoices/in_1',
      'GET /api/v1/customers/cus_A1',
      'POST /api/v1/invoices/in_1/send',
    ])
  })

  it('pdf saves the bytes and can open the file', async () => {
    const pdf = new TextEncoder().encode('%PDF-1.7 fake')
    const f = fakeFetch(() => new Response(pdf, { headers: { 'content-type': 'application/pdf' } }))
    const h = harness({ fetch: f, env })
    const out = join(mkdtempSync(join(tmpdir(), 'pdf-')), 'inv.pdf')
    expect(await h.run('invoices', 'pdf', 'in_1', '--out', out, '--open')).toBe(0)
    expect(readFileSync(out, 'utf8')).toBe('%PDF-1.7 fake')
    expect(h.opened).toEqual([out])
  })
})

describe('invoice-ai api', () => {
  it('uses the SDK request() with query and body', async () => {
    const f = fakeFetch(({ method, url, body, headers }) => {
      expect(method).toBe('POST')
      expect(url.pathname).toBe('/api/v1/customers')
      expect(url.searchParams.getAll('tag')).toEqual(['a', 'b'])
      expect(JSON.parse(body)).toEqual({ name: 'Acme' })
      expect(headers.get('authorization')).toBe('Bearer inv_live_ab12cd34_x')
      return json({ data: customer() }, 201)
    })
    const h = harness({ fetch: f, env })
    expect(await h.run('api', 'post', '/api/v1/customers', '--data', '{"name":"Acme"}', '-q', 'tag=a', '-q', 'tag=b')).toBe(0)
    expect(JSON.parse(h.stdout.text).data.id).toBe('cus_A1')
  })

  it('reads --data from a file', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'data-')), 'body.json')
    writeFileSync(file, '{"email":"x@y.test"}')
    const f = fakeFetch(({ body }) => {
      expect(JSON.parse(body)).toEqual({ email: 'x@y.test' })
      return json({ data: customer() })
    })
    const h = harness({ fetch: f, env })
    expect(await h.run('api', 'PATCH', 'customers/cus_A1', '--data', `@${file}`)).toBe(0)
    expect(f.calls[0]!.url.pathname).toBe('/api/v1/customers/cus_A1')
  })

  it('rejects unknown methods and bad JSON with exit 2', async () => {
    const h = harness({ env })
    expect(await h.run('api', 'TRACE', '/business')).toBe(2)
    expect(await h.run('api', 'POST', '/customers', '--data', '{nope')).toBe(2)
  })

  it('parseQueryPairs groups repeats and rejects missing "="', () => {
    expect(parseQueryPairs(['a=1', 'b=x=y', 'a=2'])).toEqual({ a: ['1', '2'], b: 'x=y' })
    expect(() => parseQueryPairs(['oops'])).toThrow(/key=value/)
  })
})

describe('webhooks test', () => {
  const secret = 'whsec_' + Buffer.from('a-test-secret-of-24-bytes').toString('base64')

  it('sends an invoice.paid v2 event the SDK verifier accepts', async () => {
    let received: { body: string; headers: Headers } | undefined
    const f = fakeFetch(({ body, headers }) => {
      received = { body, headers }
      return new Response('ok', { status: 200 })
    })
    // No API key needed.
    const h = harness({ fetch: f, env: { INVOICE_AI_API_KEY: undefined } })
    expect(await h.run('webhooks', 'test', 'https://example.test/hooks', '--secret', secret)).toBe(0)
    expect(received).toBeDefined()
    const now = Math.floor(h.deps.now() / 1000)
    const event = await constructEvent(received!.body, received!.headers, secret, { now })
    expect(event.type).toBe('invoice.paid')
    expect(event.data.object).toMatchObject({ object: 'invoice', status: 'paid', currency: 'USD' })
    expect(Number.isInteger(event.data.object.total)).toBe(true)
    expect(received!.headers.get('webhook-id')).toMatch(/^msg_/)
    // Piped, so the result is JSON on stdout.
    expect(JSON.parse(h.stdout.text)).toMatchObject({ status: 200, ok: true, event_id: event.id })
  })

  it('exits 1 when the receiver rejects it, 2 on a bad secret', async () => {
    const h = harness({ fetch: fakeFetch(() => new Response('bad sig', { status: 400 })) })
    expect(await h.run('webhooks', 'test', 'https://example.test/hooks', '--secret', secret)).toBe(1)
    expect(h.stderr.text).toContain('400')
    expect(await h.run('webhooks', 'test', 'https://example.test/hooks', '--secret', 'nope')).toBe(2)
    expect(await h.run('webhooks', 'test', 'https://example.test/hooks', '--secret', secret, '--event', 'invoice.bogus')).toBe(2)
  })

  it('buildSignedTestEvent produces the documented envelope', async () => {
    const { event } = await buildSignedTestEvent(secret, 'invoice.voided', new Date('2026-09-22T00:00:00Z'))
    expect(Object.keys(event).sort()).toEqual(['created_at', 'data', 'id', 'type'])
    expect(event.type).toBe('invoice.voided')
  })
})

describe('open / docs', () => {
  it('open prints (and in a TTY opens) the dashboard of the configured site', async () => {
    const h = harness({ tty: true })
    expect(await h.run('open')).toBe(0)
    expect(h.stdout.text.trim()).toBe('https://api.test/dashboard')
    expect(h.opened).toEqual(['https://api.test/dashboard'])
  })

  it('open invoice <id> resolves the public link through the SDK', async () => {
    const h = harness({ fetch: fakeFetch(() => json({ data: invoice() })), env })
    expect(await h.run('open', 'invoice', 'in_1')).toBe(0)
    expect(h.stdout.text.trim()).toBe('https://api.test/i/tok_abc')
    expect(h.opened).toEqual([]) // not a TTY
  })

  it('docs maps topics onto the docs site and rejects unknown ones', async () => {
    const h = harness()
    expect(await h.run('docs', 'webhooks')).toBe(0)
    expect(h.stdout.text.trim()).toBe(`${DOCS_BASE_URL}/webhooks`)
    expect(await h.run('docs', 'nope')).toBe(2)
  })
})

describe('completion', () => {
  it.each(['bash', 'zsh', 'fish'])('%s script covers the command tree', async (shell) => {
    const h = harness()
    expect(await h.run('completion', shell)).toBe(0)
    const script = h.stdout.text
    for (const word of ['customers', 'invoices', 'finalize', '--status', 'webhooks', 'completion']) {
      expect(script).toContain(word)
    }
  })

  it('bash script is valid bash', async () => {
    const h = harness()
    await h.run('completion', 'bash')
    const { spawnSync } = await import('node:child_process')
    const res = spawnSync('bash', ['-n'], { input: h.stdout.text })
    expect(res.status).toBe(0)
  })

  it('rejects other shells (exit 2)', async () => {
    const h = harness()
    expect(await h.run('completion', 'powershell')).toBe(2)
  })
})

describe('update notifier', () => {
  it('compares versions', () => {
    expect(isNewer('0.2.0', '0.1.0')).toBe(true)
    expect(isNewer('0.1.0', '0.1.0')).toBe(false)
    expect(isNewer('0.0.9', '0.1.0')).toBe(false)
    expect(isNewer('1.0.0-beta.1', '0.1.0')).toBe(false)
  })

  it('checks at most daily, in the background, and never in CI or without a TTY', () => {
    const dir = mkdtempSync(join(tmpdir(), 'upd-'))
    const refreshes: string[] = []
    const base = { configDir: dir, refresh: (f: string) => refreshes.push(f) }
    const now = Date.parse('2026-09-22T00:00:00Z')

    expect(checkForUpdate({ ...base, env: { CI: 'true' }, stderrIsTTY: true, now })).toBeUndefined()
    expect(checkForUpdate({ ...base, env: {}, stderrIsTTY: false, now })).toBeUndefined()
    expect(refreshes).toHaveLength(0)

    expect(checkForUpdate({ ...base, env: {}, stderrIsTTY: true, now })).toBeUndefined()
    expect(refreshes).toHaveLength(1) // first run: starts a check, shows nothing

    // What the background check would write:
    writeFileSync(join(dir, 'update-check.json'), JSON.stringify({ checked_at: now, latest: '9.9.9' }))
    expect(checkForUpdate({ ...base, env: {}, stderrIsTTY: true, now: now + 1000 })).toContain('9.9.9')
    expect(refreshes).toHaveLength(1) // within a day: no new check
    checkForUpdate({ ...base, env: {}, stderrIsTTY: true, now: now + 25 * 3600_000 })
    expect(refreshes).toHaveLength(2)
  })
})
