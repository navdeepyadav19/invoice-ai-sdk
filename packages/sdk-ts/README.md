# @horizonpay/invoice-ai

The official TypeScript SDK for the [Invoice-AI API](https://docs.horizonpay.co). It has no runtime dependencies and works in Node 20+, Bun, Deno and edge runtimes, from both ESM and CommonJS.

```sh
npm install @horizonpay/invoice-ai
```

```ts
import InvoiceAI from '@horizonpay/invoice-ai'

const invoiceai = new InvoiceAI() // reads INVOICE_AI_API_KEY

const customer = await invoiceai.customers.create({ name: 'Acme', email: 'ap@acme.com' })
const draft = await invoiceai.invoices.create({ customer: customer.id, items: [{ price: 'price_…', quantity: 1 }] })
await invoiceai.invoices.finalize(draft.id)
await invoiceai.invoices.send(draft.id)

for await (const inv of invoiceai.invoices.list({ status: 'open' })) console.log(inv.number)
```

From CommonJS, use the named export:

```js
const { InvoiceAI } = require('@horizonpay/invoice-ai')

const invoiceai = new InvoiceAI({ apiKey: process.env.INVOICE_AI_API_KEY })
```

## What it handles for you

- **Retries.** Network errors, timeouts, 408, 409 `conflict`, 429 and 5xx are retried up to `maxRetries` (default 2). Backoff is exponential with jitter, and the SDK waits out `Retry-After` / `RateLimit-Reset`. A PATCH or DELETE that may have reached the server is never resent.
- **Idempotency.** Every POST gets an `Idempotency-Key`, and retries reuse it, so a retried create can't run twice. To choose the key yourself, pass `{ idempotencyKey }`.
- **Pagination.** `await list()` returns one page (`data`, `nextCursor`, `hasMore`). `for await` walks every page. `.toArray({ limit })` collects a bounded number of items.
- **Errors.** Each server `code` has its own class: `ValidationError` (with `.fields`), `InvalidStateError`, `NotFoundError`, `RateLimitError`, `IdempotencyError` and the rest. They all extend `APIError`, which carries `status`, `code`, `detail` and `requestId`.
- **Webhooks.** `await invoiceai.webhooks.constructEvent(rawBody, headers, secret)` verifies the Standard Webhooks signature and returns a typed event.
- **Money.** Amounts are integers in minor units. `toMinor('25.00', 'USD')`, `fromMinor(2500, 'USD')` and `formatMoney(5000, 'JPY')` use each currency's own number of decimals.

Every method takes request options as its last argument: `{ idempotencyKey, timeout, maxRetries, signal, headers }`. `timeout` is in **milliseconds**, as it is on the client. To read headers, call `.withResponse()`:

```ts
const { data, response } = await invoiceai.invoices.retrieve('in_…').withResponse()
response.requestId; response.rateLimit.remaining
```

For endpoints the SDK doesn't wrap yet, use `invoiceai.request('GET', '/business')`.

## Configuration

| Option | Env var | Default |
|---|---|---|
| `apiKey` | `INVOICE_AI_API_KEY` | — |
| `baseURL` | `INVOICE_AI_BASE_URL` | `https://invoice.horizonpay.co/api/v1` |
| `timeout` (milliseconds) | | `60000` (60 s) |
| `maxRetries` | | `2` |
| `logLevel` | `INVOICE_AI_LOG` | `warn` (`debug` logs each request, with secrets redacted) |
| `fetch` | | global `fetch` |

For runnable scripts, see [`examples/`](https://github.com/navdeepyadav19/invoice-ai-sdk/tree/main/packages/sdk-ts/examples). The full guide and API reference are at [docs.horizonpay.co](https://docs.horizonpay.co), and release notes are in the [changelog](https://github.com/navdeepyadav19/invoice-ai-sdk/blob/main/packages/sdk-ts/CHANGELOG.md).

## Development

The spec is the source of truth. After changing `api-docs/openapi.json`, run `pnpm sdk:gen` from the repo root. It regenerates `src/generated/` and `src/resources/`; don't edit those by hand.

```sh
pnpm --filter @horizonpay/invoice-ai test           # unit tests
pnpm --filter @horizonpay/invoice-ai test:contract  # every method against a Prism mock
pnpm --filter @horizonpay/invoice-ai build
```

## License

[MIT](https://github.com/navdeepyadav19/invoice-ai-sdk/blob/main/packages/sdk-ts/LICENSE)
