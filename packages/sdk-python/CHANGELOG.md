# Changelog

All notable changes to `horizonpay-invoice-ai` are documented here. The TypeScript SDK, Python SDK and CLI share one version number.

## 0.1.0

Initial release.

- Sync (`InvoiceAI`) and asyncio (`AsyncInvoiceAI`) clients for every endpoint in the Invoice-AI API v1 spec.
- Automatic retries with exponential backoff and jitter, honouring `Retry-After` / `RateLimit-Reset`.
- An `Idempotency-Key` on every POST, reused across retries.
- Cursor pagination: iterate a `list()` result to walk every page, or `.to_list(limit=...)`.
- A typed exception per API error code, all extending `APIError`.
- Standard Webhooks signature verification (`Webhook`, `client.webhooks.construct_event`).
- Money helpers (`to_minor`, `from_minor`, `format_money`) that use each currency's number of decimals.
- Pydantic v2 response models generated from the OpenAPI spec, with lenient parsing.
- `.with_raw_response` for request IDs, rate-limit and idempotency headers.
- Requires Python 3.10+.
