# Invoice-AI SDKs and CLI

Official client libraries and command-line tool for the [Invoice-AI API](https://docs.horizonpay.co).

| Package | Install | Docs |
|---|---|---|
| TypeScript / JavaScript SDK | `npm install @horizonpay/invoice-ai` | [packages/sdk-ts](packages/sdk-ts) |
| Python SDK | `pip install horizonpay-invoice-ai` | [packages/sdk-python](packages/sdk-python) |
| CLI (`invoice-ai`) | `npm install -g @horizonpay/invoice-ai-cli` | [packages/cli](packages/cli) |

```ts
import InvoiceAI from '@horizonpay/invoice-ai'

const invoiceai = new InvoiceAI() // reads INVOICE_AI_API_KEY
const invoice = await invoiceai.invoices.create({ customer: 'cus_…', currency: 'USD', items: [{ price: 'price_…', quantity: 1 }] })
await invoiceai.invoices.finalize(invoice.id)
```

Full guides: **[docs.horizonpay.co](https://docs.horizonpay.co)**.

> **Beta.** Versions `0.x` may change before `1.0`. See [Versioning](https://docs.horizonpay.co/sdks/versioning).

## How this repo works

- `spec/openapi.json` is the API contract. It's copied here automatically from the API repo when the API changes; don't edit it by hand.
- `pnpm sdk:gen` regenerates the types and resource classes of both SDKs from the spec. The retry, idempotency, pagination, error and webhook code is hand-written in each SDK's `core`.
- The CLI is built on the TypeScript SDK and contains no HTTP code for the API.

See [CONTRIBUTING.md](CONTRIBUTING.md) for development and releases.

## License

MIT
