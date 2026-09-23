# horizonpay-invoice-ai

The official Python SDK for the [Invoice-AI API](https://invoice.horizonpay.co). It supports Python 3.10+, with a sync client (`InvoiceAI`) and an asyncio client (`AsyncInvoiceAI`), and depends only on `httpx` and `pydantic`.

```sh
pip install horizonpay-invoice-ai      # or: uv add horizonpay-invoice-ai
```

```python
from invoice_ai import InvoiceAI

client = InvoiceAI()  # reads INVOICE_AI_API_KEY

customer = client.customers.create(name="Acme", email="ap@acme.com")
draft = client.invoices.create(customer=customer.id, items=[{"price": "price_…", "quantity": 1}])
client.invoices.finalize(draft.id)
client.invoices.send(draft.id)

for inv in client.invoices.list(status="open"):  # walks every page
    print(inv.number)
```

Async works the same way:

```python
from invoice_ai import AsyncInvoiceAI

async with AsyncInvoiceAI() as client:
    invoice = await client.invoices.retrieve("in_…")
    async for inv in client.invoices.list(status="open"):
        print(inv.number)
```

## What it handles for you

- **Retries.** Network errors, timeouts, 408, 409 `conflict`, 429 and 5xx are retried up to `max_retries` (default 2). Backoff is exponential with jitter, and the SDK waits out `Retry-After` / `RateLimit-Reset`. A PATCH or DELETE that may have reached the server is never resent.
- **Idempotency.** Every POST gets an `Idempotency-Key`, and retries reuse it, so a retried create can't run twice. To choose the key yourself, pass `idempotency_key=...`.
- **Pagination.** `list()` returns one page (`data`, `next_cursor`, `has_more`). Iterating it (`for` / `async for`) walks every page. `.to_list(limit=500)` collects a bounded number of items.
- **Errors.** Each server `code` has its own exception: `ValidationError` (with `.fields`), `InvalidStateError`, `NotFoundError`, `RateLimitError`, `IdempotencyError` and the rest. They all extend `APIError`, which carries `status`, `code`, `detail` and `request_id`.
- **Webhooks.** `client.webhooks.construct_event(raw_body, headers, secret)` (or `Webhook(secret).verify(raw_body, headers)`) verifies the Standard Webhooks signature and returns a typed `WebhookEvent`.
- **Money.** Amounts are integers in minor units. `to_minor("25.00", "USD")`, `from_minor(2500, "USD")` (a `Decimal`) and `format_money(5000, "JPY")` use each currency's own number of decimals.
- **Types.** Every response is a Pydantic v2 model generated from the OpenAPI spec (`invoice_ai.types`). Parsing is lenient: a field or enum value the SDK doesn't know yet never raises.

Every method takes keyword arguments, with path parameters first (`client.invoices.void("in_…", reason="Duplicate")`), plus the request options `idempotency_key`, `timeout` (in seconds, not milliseconds), `max_retries` and `extra_headers`. To read headers, use `.with_raw_response`:

```python
raw = client.invoices.with_raw_response.retrieve("in_…")
raw.request_id; raw.rate_limit.remaining; raw.idempotent_replayed
invoice = raw.parse()
```

For endpoints the SDK doesn't wrap yet, use `client.request("GET", "/business")`.

## Verifying webhooks

Pass the **raw** request body to `Webhook.verify` (or `client.webhooks.construct_event`). A body that has been parsed and re-serialised as JSON won't match the signature. With FastAPI:

```python
import os

from fastapi import FastAPI, HTTPException, Request
from invoice_ai import Webhook, WebhookVerificationError

app = FastAPI()
webhook = Webhook(os.environ["INVOICE_AI_WEBHOOK_SECRET"])  # whsec_…, from webhook_endpoints.create()


@app.post("/webhooks/invoice-ai")
async def invoice_ai_webhook(request: Request) -> dict[str, bool]:
    raw = await request.body()  # bytes, exactly as sent
    try:
        event = webhook.verify(raw, request.headers)
    except WebhookVerificationError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    if event.type == "invoice.paid":
        print(f"{event.data.object.number} was paid")
    return {"received": True}
```

Deliveries can repeat, so deduplicate on `event.id`. For a standard-library version, see [`examples/verify_webhook.py`](https://github.com/navdeepyadav19/invoice-ai-sdk/blob/main/packages/sdk-python/examples/verify_webhook.py).

## Configuration

| Option | Env var | Default |
|---|---|---|
| `api_key` | `INVOICE_AI_API_KEY` | — |
| `base_url` | `INVOICE_AI_BASE_URL` | `https://invoice.horizonpay.co/api/v1` |
| `timeout` | | `60` (seconds; a float, e.g. `2.5`) |
| `max_retries` | | `2` |
| `log_level` | `INVOICE_AI_LOG` | `warn` (`debug` logs each request to the `invoice_ai` logger, with secrets redacted) |
| `http_client` | | a new `httpx.Client` / `httpx.AsyncClient` |
| `default_headers` | | — |

For runnable scripts, see [`examples/`](https://github.com/navdeepyadav19/invoice-ai-sdk/tree/main/packages/sdk-python/examples).

## Development

The spec is the source of truth. After changing `api-docs/openapi.json`, run `pnpm sdk:gen` from the repo root. It regenerates `invoice_ai/resources/`, `invoice_ai/types/`, `_operations.py` and `_meta.py`; don't edit those by hand.

```sh
uv sync
uv run pytest                 # unit tests
uv run pytest -m contract     # every method against a Prism mock of the spec (needs npx)
uv run ruff check && uv run mypy invoice_ai
```
