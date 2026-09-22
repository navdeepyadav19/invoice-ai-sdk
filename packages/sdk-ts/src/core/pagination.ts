import { APIPromise } from './api-promise'
import type { APIResponse, ResponseMeta } from './http'

/**
 * Cursor pagination.
 *
 * `list()` returns one page — `{ data, nextCursor, hasMore }` — and the same
 * object walks every page when you loop over it:
 *
 *   const page = await invoiceai.invoices.list({ limit: 50 })   // one page
 *   for await (const inv of invoiceai.invoices.list())           // every invoice
 *   const first500 = await invoiceai.invoices.list().toArray({ limit: 500 })
 *
 * Endpoints that return a plain array (no `next_cursor`) produce a single page
 * with `hasMore: false`, so the same code works everywhere.
 */

/** Loads the page after `cursor`. */
export type PageFetcher<Item> = (cursor: string) => PagePromise<Item>

export interface ToArrayOptions {
  /** Stop after this many items in total. */
  limit?: number
}

export class Page<Item> implements AsyncIterable<Item> {
  /** The items on this page. */
  readonly data: Item[]
  /** Pass as `cursor` to get the next page; null on the last page. */
  readonly nextCursor: string | null
  readonly hasMore: boolean
  /** Response metadata of the request that loaded this page. */
  readonly response: ResponseMeta

  constructor(
    body: unknown,
    response: ResponseMeta,
    private readonly fetchNext: PageFetcher<Item>,
  ) {
    const b = (body ?? {}) as { data?: unknown; next_cursor?: unknown }
    this.data = Array.isArray(b.data) ? (b.data as Item[]) : []
    this.nextCursor = typeof b.next_cursor === 'string' && b.next_cursor !== '' ? b.next_cursor : null
    this.hasMore = this.nextCursor !== null
    this.response = response
  }

  hasNextPage(): boolean {
    return this.hasMore
  }

  /** The next page, or null when this is the last one. */
  async getNextPage(): Promise<Page<Item> | null> {
    return this.nextCursor === null ? null : this.fetchNext(this.nextCursor)
  }

  /** This page and every page after it. */
  async *iterPages(): AsyncGenerator<Page<Item>, void, undefined> {
    yield this
    let page = await this.getNextPage()
    while (page) {
      yield page
      page = await page.getNextPage()
    }
  }

  /** Every item on this page and the pages after it. */
  async *[Symbol.asyncIterator](): AsyncGenerator<Item, void, undefined> {
    for await (const page of this.iterPages()) yield* page.data
  }

  /** Collects items across pages, up to `limit` if given. */
  async toArray(options: ToArrayOptions = {}): Promise<Item[]> {
    return collect(this, options.limit)
  }
}

/** A pending page: await it for one page, or `for await` it for every item. */
export class PagePromise<Item> extends APIPromise<Page<Item>> implements AsyncIterable<Item> {
  constructor(responsePromise: Promise<APIResponse>, fetchNext: PageFetcher<Item>) {
    super(responsePromise, (res) => new Page<Item>(res.body, res.meta, fetchNext))
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Item, void, undefined> {
    const page = await this
    yield* page
  }

  /** Collects items across pages, up to `limit` if given. */
  async toArray(options: ToArrayOptions = {}): Promise<Item[]> {
    return collect(this, options.limit)
  }
}

async function collect<Item>(source: AsyncIterable<Item>, limit: number | undefined): Promise<Item[]> {
  const out: Item[] = []
  if (limit !== undefined && limit <= 0) return out
  for await (const item of source) {
    out.push(item)
    if (limit !== undefined && out.length >= limit) break
  }
  return out
}
