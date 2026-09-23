# @horizonpay/invoice-ai-cli

## 0.1.0

First public release (beta).

- `invoice-ai login` with a browser device flow; keys are stored in the OS keychain (or a 0600 config file). Profiles, `switch`, `whoami` and `logout`.
- Commands for `customers`, `products`, `prices` (including `prices update` for nickname and tax rate), `invoices`, `invoice-items` (`list`, `get`, `create`, `delete`) and `webhooks`.
- `invoice-ai invoices create` with no flags starts a guided wizard: search a customer, pick prices, confirm, then finalize or send.
- `invoice-ai api <method> <path>` calls any endpoint; `webhooks test` sends a correctly signed sample event.
- Tables in a terminal, JSON when piped, `--format csv`; stable exit codes for scripting.
- Shell completion for bash, zsh and fish.
- Requires Node 20+.
