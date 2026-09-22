import { describe, expect, it } from 'vitest'
import { customerColumns, invoiceColumns } from '../src/output/columns'
import { csvCell, renderCsv, renderJson, renderObject, renderTable, resolveFormat } from '../src/output/format'
import { makeColors } from '../src/util/colors'
import { colorsEnabled } from '../src/util/colors'
import { customer, fakeFetch, harness, invoice, json } from './harness'

const plain = makeColors(false)

describe('resolveFormat', () => {
  it('tables in a terminal, JSON when piped', () => {
    expect(resolveFormat({}, true)).toBe('table')
    expect(resolveFormat({}, false)).toBe('json')
  })
  it('--json and --format override detection', () => {
    expect(resolveFormat({ json: true }, true)).toBe('json')
    expect(resolveFormat({ format: 'csv' }, true)).toBe('csv')
    expect(resolveFormat({ format: 'TABLE' }, false)).toBe('table')
    expect(() => resolveFormat({ format: 'xml' }, true)).toThrow(/Unknown --format/)
  })
})

describe('colorsEnabled', () => {
  it('respects NO_COLOR, --no-color, TERM=dumb, TTY and FORCE_COLOR', () => {
    expect(colorsEnabled({}, true, true)).toBe(true)
    expect(colorsEnabled({}, false, true)).toBe(false)
    expect(colorsEnabled({ NO_COLOR: '1' }, true, true)).toBe(false)
    expect(colorsEnabled({}, true, false)).toBe(false)
    expect(colorsEnabled({ TERM: 'dumb' }, true, true)).toBe(false)
    expect(colorsEnabled({ FORCE_COLOR: '1' }, false, true)).toBe(true)
  })
})

describe('renderers', () => {
  const rows = [customer(), customer({ id: 'cus_B2', name: 'Beta, "Ltd"', email: null })] as never[]

  it('renders a borderless table with formatted values', () => {
    expect(renderTable(rows, customerColumns, plain)).toMatchInlineSnapshot(`
      "ID      NAME         EMAIL            CREATED
      cus_A1  Acme Corp    ap@acme.example  2026-09-01
      cus_B2  Beta, "Ltd"  —                2026-09-01"
    `)
  })

  it('formats money by currency in tables and keeps minor units in CSV', () => {
    const inv = [invoice({ total: 123456, currency: 'USD' }), invoice({ id: 'in_2', total: 5000, currency: 'JPY', status: 'paid' })] as never[]
    const table = renderTable(inv, invoiceColumns, plain)
    expect(table).toContain('$1,234.56')
    expect(table).toContain('¥5,000')
    const csv = renderCsv(inv, invoiceColumns)
    expect(csv.split('\n')[0]).toBe('ID,NUMBER,STATUS,CUSTOMER,TOTAL,CURRENCY,DUE')
    expect(csv.split('\n')[1]).toBe('in_1,INV-0001,draft,cus_A1,123456,USD,2026-10-22')
  })

  it('escapes CSV per RFC 4180', () => {
    expect(renderCsv(rows, customerColumns)).toBe(
      'ID,NAME,EMAIL,CREATED\ncus_A1,Acme Corp,ap@acme.example,2026-09-01T12:00:00Z\ncus_B2,"Beta, ""Ltd""",,2026-09-01T12:00:00Z',
    )
    expect(csvCell('line\nbreak')).toBe('"line\nbreak"')
    expect(csvCell({ a: 1 })).toBe('"{""a"":1}"')
    expect(csvCell(' padded')).toBe('" padded"')
  })

  it('renders one object as key/value rows', () => {
    expect(renderObject({ id: 'cus_A1', deleted: false, email: null, tags: ['a', 'b'] }, plain)).toBe(
      'id       cus_A1\ndeleted  no\nemail    —\ntags     a, b',
    )
  })

  it('pretty-prints JSON', () => {
    expect(renderJson({ a: 1 })).toBe('{\n  "a": 1\n}')
  })
})

describe('--debug', () => {
  it('logs SDK requests to stderr with the key redacted', async () => {
    const key = 'inv_live_ab12cd34_topsecretvalue'
    const h = harness({ fetch: fakeFetch(() => json({ data: [], next_cursor: null })), env: { INVOICE_AI_API_KEY: key } })
    expect(await h.run('customers', 'list', '--debug')).toBe(0)
    expect(h.stderr.text).toContain('/customers')
    expect(h.stderr.text).not.toContain('topsecretvalue')
    expect(h.stdout.text).not.toContain('debug')
  })
})

describe('list output through the CLI', () => {
  const api = () =>
    fakeFetch(({ url }) => {
      if (url.pathname === '/api/v1/customers') {
        return json({ data: [customer(), customer({ id: 'cus_B2', name: 'Beta' })], next_cursor: 'cur_next' })
      }
      return json({}, 404)
    })

  it('prints a table in a TTY with a pagination hint on stderr', async () => {
    const h = harness({ fetch: api(), tty: true, env: { INVOICE_AI_API_KEY: 'inv_live_ab12cd34_x', NO_COLOR: '1' } })
    expect(await h.run('customers', 'list')).toBe(0)
    expect(h.stdout.text).toContain('cus_A1  Acme Corp')
    expect(h.stdout.text.split('\n')[0]).toMatch(/^ID\s+NAME\s+EMAIL\s+CREATED$/)
    expect(h.stderr.text).toContain('--cursor cur_next')
  })

  it('prints the raw page as JSON with --json', async () => {
    const h = harness({ fetch: api(), tty: true, env: { INVOICE_AI_API_KEY: 'inv_live_ab12cd34_x' } })
    expect(await h.run('customers', 'list', '--json')).toBe(0)
    const out = JSON.parse(h.stdout.text)
    expect(out.next_cursor).toBe('cur_next')
    expect(out.data).toHaveLength(2)
    expect(out.data[0]).toEqual(customer())
  })

  it('defaults to JSON when stdout is not a terminal', async () => {
    const h = harness({ fetch: api(), tty: false, env: { INVOICE_AI_API_KEY: 'inv_live_ab12cd34_x' } })
    expect(await h.run('customers', 'list')).toBe(0)
    expect(JSON.parse(h.stdout.text).data).toHaveLength(2)
  })

  it('writes CSV with --format csv', async () => {
    const h = harness({ fetch: api(), tty: true, env: { INVOICE_AI_API_KEY: 'inv_live_ab12cd34_x' } })
    expect(await h.run('customers', 'list', '--format', 'csv')).toBe(0)
    expect(h.stdout.text.trim().split('\n')).toEqual([
      'ID,NAME,EMAIL,CREATED',
      'cus_A1,Acme Corp,ap@acme.example,2026-09-01T12:00:00Z',
      'cus_B2,Beta,ap@acme.example,2026-09-01T12:00:00Z',
    ])
  })

  it('--all walks every page through the SDK iterator', async () => {
    const f = fakeFetch(({ url }) => {
      const cursor = url.searchParams.get('cursor')
      if (!cursor) return json({ data: [customer()], next_cursor: 'p2' })
      return json({ data: [customer({ id: 'cus_B2' })], next_cursor: null })
    })
    const h = harness({ fetch: f, env: { INVOICE_AI_API_KEY: 'inv_live_ab12cd34_x' } })
    expect(await h.run('customers', 'list', '--all', '--limit', '1')).toBe(0)
    const out = JSON.parse(h.stdout.text)
    expect(out.data.map((c: { id: string }) => c.id)).toEqual(['cus_A1', 'cus_B2'])
    expect(f.calls.map((c) => c.url.search)).toEqual(['?limit=1', '?limit=1&cursor=p2'])
  })
})
