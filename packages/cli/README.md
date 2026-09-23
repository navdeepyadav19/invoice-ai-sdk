# invoice-ai

The Invoice-AI command line. Log in with your browser once, then manage customers, products, prices, invoices and webhooks from your terminal.

Built on the official TypeScript SDK ([`@horizonpay/invoice-ai`](https://github.com/navdeepyadav19/invoice-ai-sdk/tree/main/packages/sdk-ts)), so retries, idempotency keys, pagination and error handling behave exactly as they do in your own code.

## Install

```bash
npm install -g @horizonpay/invoice-ai-cli     # Node 20+
invoice-ai --help

# or, one-off:
npx @horizonpay/invoice-ai-cli invoices list
```

## Log in

```bash
invoice-ai login
```

This prints a one-time code and opens the browser. Approve the device there. The CLI gets a new API key for this machine and stores it in your OS keychain. If there's no keychain, it uses `~/.config/invoice-ai/config.json` with mode 0600. `invoice-ai whoami` shows who you are. `invoice-ai logout` revokes the key and forgets it.

- **CI and scripts:** set `INVOICE_AI_API_KEY`. It takes priority over the saved login. `--api-key` takes priority over both.
- **Several accounts:** use `invoice-ai login --profile work`, then `invoice-ai switch work`, or pass `--profile work` on any command.
- **No browser:** `invoice-ai login --api-key inv_live_…` checks the key and stores it.
- **Local or preview servers:** `INVOICE_AI_BASE_URL=http://localhost:3000/api/v1 invoice-ai login`.

## Five commands to start with

```bash
invoice-ai invoices create                                   # guided wizard
invoice-ai invoices create --customer cus_123 --price price_abc --qty 2 --send
invoice-ai invoices list --status open --json | jq '.data[].number'
invoice-ai invoices pdf in_123 --open
invoice-ai api GET /business                                 # any endpoint, raw JSON
```

Every resource has its own group: `customers`, `products`, `prices` (`list`, `get`, `create`, `update`, `archive`), `invoices`, `invoice-items` (`list`, `get`, `create`, `delete` lines on a draft) and `webhooks`:

```bash
invoice-ai invoice-items create --invoice in_123 --price price_abc --qty 3
invoice-ai invoice-items create --invoice in_123 --description "Rush fee" --amount 50 --currency USD
invoice-ai prices update price_abc --nickname "Annual" --tax-rate 18
```

More: `webhooks test <url> --secret whsec_…` sends a correctly signed sample event to your receiver. `open invoice <id>` opens the invoice's public page. `docs webhooks` opens the docs. `completion zsh` prints a shell completion script. The full command reference is at [docs.horizonpay.co/cli/commands](https://docs.horizonpay.co/cli/commands), generated from `--help` by `pnpm cli:docs`. Release notes are in the [changelog](https://github.com/navdeepyadav19/invoice-ai-sdk/blob/main/packages/cli/CHANGELOG.md).

## Output and scripting

- **Output format:** you get tables in a terminal and JSON when piped. Use `--json` or `--format csv` to choose.
- **Colours:** `NO_COLOR` and `--no-color` turn them off.
- **Confirmations:** destructive commands (`void`, `delete`, `archive`) ask first. `--yes` skips the prompt. Without a terminal, they refuse and exit 2 instead of guessing.
- **Debugging:** `--debug` logs each request and retry. Keys are redacted.
- **Exit codes:**

| Code | Meaning |
|---|---|
| 0 | ok |
| 1 | API error |
| 2 | usage error |
| 3 | not logged in / key rejected / missing scope |
| 4 | rate limited |

## Development

```bash
pnpm --filter @horizonpay/invoice-ai build      # the CLI imports the built SDK
pnpm --filter @horizonpay/invoice-ai-cli build  # dist/index.js, one ESM file
pnpm --filter @horizonpay/invoice-ai-cli test   # unit + --help snapshots (uses SDK source)
pnpm --filter @horizonpay/invoice-ai-cli test:e2e   # built binary vs a Prism mock
```

## License

[MIT](https://github.com/navdeepyadav19/invoice-ai-sdk/blob/main/packages/cli/LICENSE)
