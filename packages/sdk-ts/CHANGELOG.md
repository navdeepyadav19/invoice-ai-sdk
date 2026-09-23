# @horizonpay/invoice-ai

## 0.1.0

First public release (beta).

- A typed client for every endpoint of the Invoice-AI API v1: business, customers, products, prices, invoices (create, update, finalize, send, pay, void, PDF, events), invoice items and webhook endpoints.
- Automatic retries with exponential backoff and jitter, honouring `Retry-After` and `RateLimit-Reset`.
- An automatic `Idempotency-Key` on every POST, reused across retries.
- Cursor pagination: `await list()` for one page, `for await` for every page, `.toArray({ limit })` for a bounded list.
- One error class per API error `code`, all extending `APIError`.
- Webhook signature verification (Standard Webhooks) with typed events.
- Money helpers (`toMinor`, `fromMinor`, `formatMoney`) that use each currency's own decimals.
- Works in Node 20+, Bun, Deno and edge runtimes, from ESM and CommonJS. No runtime dependencies.
