import type { APIResponse, ResponseMeta } from './http'

/**
 * What every SDK method returns: a promise of the parsed data that can also
 * hand you the HTTP response.
 *
 *   const invoice = await invoiceai.invoices.retrieve(id)
 *   const { data, response } = await invoiceai.invoices.retrieve(id).withResponse()
 *   response.requestId; response.rateLimit.remaining
 */
export class APIPromise<T> implements PromiseLike<T> {
  private parsed: Promise<T> | undefined

  constructor(
    private readonly responsePromise: Promise<APIResponse>,
    private readonly parse: (res: APIResponse) => T,
  ) {}

  private data(): Promise<T> {
    this.parsed ??= this.responsePromise.then(this.parse)
    return this.parsed
  }

  /** The parsed data together with the response metadata. */
  async withResponse(): Promise<{ data: T; response: ResponseMeta }> {
    const [data, res] = await Promise.all([this.data(), this.responsePromise])
    return { data, response: res.meta }
  }

  /** Only the response metadata (status, headers, request id, rate limit). */
  async asResponse(): Promise<ResponseMeta> {
    return (await this.responsePromise).meta
  }

  then<R1 = T, R2 = never>(
    onfulfilled?: ((value: T) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): Promise<R1 | R2> {
    return this.data().then(onfulfilled, onrejected)
  }

  catch<R = never>(onrejected?: ((reason: unknown) => R | PromiseLike<R>) | null): Promise<T | R> {
    return this.data().catch(onrejected)
  }

  finally(onfinally?: (() => void) | null): Promise<T> {
    return this.data().finally(onfinally)
  }

  get [Symbol.toStringTag](): string {
    return 'APIPromise'
  }
}
