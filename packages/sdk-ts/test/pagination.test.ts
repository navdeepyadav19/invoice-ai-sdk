import { describe, expect, it } from 'vitest'
import { Page } from '../src/index'
import { client, customer, fakeFetch, json } from './helpers'

/** Three pages: cus_1..3, cus_4..6, cus_7..8. */
function threePages() {
  return fakeFetch((req) => {
    const cursor = req.url.searchParams.get('cursor')
    if (!cursor) return json(200, { data: ['cus_1', 'cus_2', 'cus_3'].map(customer), next_cursor: 'c2' })
    if (cursor === 'c2') return json(200, { data: ['cus_4', 'cus_5', 'cus_6'].map(customer), next_cursor: 'c3' })
    if (cursor === 'c3') return json(200, { data: ['cus_7', 'cus_8'].map(customer), next_cursor: null })
    return json(500, {})
  })
}

describe('pagination', () => {
  it('awaiting list() gives one page', async () => {
    const { fetch, calls } = threePages()
    const page = await client(fetch).customers.list({ limit: 3 })
    expect(page).toBeInstanceOf(Page)
    expect(page.data.map((c) => c.id)).toEqual(['cus_1', 'cus_2', 'cus_3'])
    expect(page.nextCursor).toBe('c2')
    expect(page.hasMore).toBe(true)
    expect(calls).toHaveLength(1)
  })

  it('for await over list() walks all three pages, keeping the filters', async () => {
    const { fetch, calls } = threePages()
    const ids: string[] = []
    for await (const c of client(fetch).customers.list({ limit: 3, query: 'acme' })) ids.push(c.id)
    expect(ids).toEqual(['cus_1', 'cus_2', 'cus_3', 'cus_4', 'cus_5', 'cus_6', 'cus_7', 'cus_8'])
    expect(calls.map((c) => c.url.search)).toEqual([
      '?limit=3&query=acme',
      '?limit=3&query=acme&cursor=c2',
      '?limit=3&query=acme&cursor=c3',
    ])
  })

  it('a fetched page is itself iterable from that page onwards', async () => {
    const { fetch } = threePages()
    const page = await client(fetch).customers.list()
    const second = await page.getNextPage()
    const rest: string[] = []
    for await (const c of second!) rest.push(c.id)
    expect(rest).toEqual(['cus_4', 'cus_5', 'cus_6', 'cus_7', 'cus_8'])
  })

  it('iterPages yields each page and getNextPage returns null at the end', async () => {
    const { fetch } = threePages()
    const page = await client(fetch).customers.list()
    const sizes: number[] = []
    let last: Page<unknown> | undefined
    for await (const p of page.iterPages()) {
      sizes.push(p.data.length)
      last = p
    }
    expect(sizes).toEqual([3, 3, 2])
    expect(last!.hasNextPage()).toBe(false)
    expect(await last!.getNextPage()).toBeNull()
  })

  it('toArray({ limit }) stops fetching once it has enough', async () => {
    const { fetch, calls } = threePages()
    const items = await client(fetch).customers.list().toArray({ limit: 4 })
    expect(items.map((c) => c.id)).toEqual(['cus_1', 'cus_2', 'cus_3', 'cus_4'])
    expect(calls).toHaveLength(2)
  })

  it('toArray() with no limit collects everything', async () => {
    const { fetch } = threePages()
    expect(await client(fetch).customers.list().toArray()).toHaveLength(8)
  })

  it('treats a plain array response (no next_cursor) as a single page', async () => {
    const { fetch, calls } = fakeFetch(json(200, { data: [{ id: 'ev_1' }, { id: 'ev_2' }] }))
    const events = await client(fetch).invoices.events('in_1').toArray()
    expect(events).toHaveLength(2)
    expect(calls).toHaveLength(1)
  })

  it('does not send an idempotency key or reuse it on later pages', async () => {
    const { fetch, calls } = threePages()
    await client(fetch).customers.list(undefined, { idempotencyKey: 'x' }).toArray()
    expect(calls.slice(1).every((c) => c.headers.get('idempotency-key') === null)).toBe(true)
  })
})
