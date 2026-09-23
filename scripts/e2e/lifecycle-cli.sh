#!/usr/bin/env bash
# Live end-to-end lifecycle through the `invoice-ai` CLI (opt-in; never runs on PRs).
#
#   INVOICE_AI_E2E_KEY=inv_live_… scripts/e2e/lifecycle-cli.sh
#
# customer → product + USD price → invoice (with the price) → finalize → send
# (to delivered@resend.dev) → pay; a second invoice → finalize → void; then
# archive the price, product and customer. Every command runs with --json --yes
# and its stdout is parsed as JSON. Prints a compact summary and exits non-zero
# on any failure. Cleanup (archiving) runs even when a step fails.
#
# Env:
#   INVOICE_AI_E2E_KEY     API key of the QA account (required)
#   INVOICE_AI_BASE_URL    API base URL (default: production)
#   INVOICE_AI_E2E_MOCK=1  running against a Prism mock: only response shapes are
#                          checked, not state transitions
#   INVOICE_AI_CLI         command to run (default: node packages/cli/dist/index.js,
#                          built with `pnpm --filter @horizonpay/invoice-ai-cli build`;
#                          e.g. INVOICE_AI_CLI=invoice-ai for an installed binary)
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RECIPIENT="delivered@resend.dev"
MOCK="${INVOICE_AI_E2E_MOCK:-}"

if [ -z "${INVOICE_AI_E2E_KEY:-}" ]; then
  echo "INVOICE_AI_E2E_KEY is not set; nothing to do." >&2
  exit 2
fi

if [ -n "${INVOICE_AI_CLI:-}" ]; then
  # shellcheck disable=SC2206 # a command line, split on purpose
  CLI=(${INVOICE_AI_CLI})
else
  BIN="$ROOT/packages/cli/dist/index.js"
  [ -f "$BIN" ] || { echo "Build the CLI first ($BIN is missing), or set INVOICE_AI_CLI." >&2; exit 2; }
  CLI=(node "$BIN")
fi

# An isolated CLI environment: the key comes from the env, never a saved profile.
CONFIG_DIR="$(mktemp -d "${TMPDIR:-/tmp}/invoice-ai-e2e.XXXXXX")"
trap 'rm -rf "$CONFIG_DIR"' EXIT
export INVOICE_AI_API_KEY="$INVOICE_AI_E2E_KEY"
export INVOICE_AI_CONFIG_DIR="$CONFIG_DIR" INVOICE_AI_NO_KEYCHAIN=1 INVOICE_AI_NO_UPDATE_CHECK=1
export INVOICE_AI_MAX_RETRIES="${INVOICE_AI_MAX_RETRIES:-2}" NO_COLOR=1 CI=1
unset INVOICE_AI_PROFILE

RUN_ID="e2e-cli-$(date -u +%Y%m%dT%H%M%S)-$RANDOM"
SUMMARY=()
FAILED=0
OUT=""

# json <expr>: evaluates a JS expression against the last command's JSON as `r`.
json() { node -e 'const r=JSON.parse(require("fs").readFileSync(0,"utf8")); const v=(0,eval)("(r)=>("+process.argv[1]+")")(r); process.stdout.write(v==null?"":String(v))' "$1" <<<"$OUT"; }

# run <name> <cli args…>: runs the CLI with --json --yes, keeps stdout in $OUT.
run() {
  local name="$1"; shift
  local start end err code
  err="$(mktemp)"
  start=$(node -e 'process.stdout.write(String(Date.now()))')
  OUT="$("${CLI[@]}" "$@" --json --yes 2>"$err")"
  code=$?
  end=$(node -e 'process.stdout.write(String(Date.now()))')
  if [ $code -ne 0 ]; then
    SUMMARY+=("$(printf 'FAIL  %-28s %5s ms  exit %s: %s' "$name" $((end - start)) "$code" "$(tr '\n' ' ' <"$err" | cut -c1-200)")")
    FAILED=$((FAILED + 1))
    rm -f "$err"
    return 1
  fi
  if ! node -e 'JSON.parse(require("fs").readFileSync(0,"utf8"))' <<<"$OUT" 2>/dev/null; then
    SUMMARY+=("$(printf 'FAIL  %-28s %5s ms  stdout is not JSON: %s' "$name" $((end - start)) "$(printf '%s' "$OUT" | head -c 200)")")
    FAILED=$((FAILED + 1))
    rm -f "$err"
    return 1
  fi
  rm -f "$err"
  LAST_NAME="$name"
  LAST_MS=$((end - start))
  return 0
}

# ok <detail>: records the last `run` as passed.
ok() { SUMMARY+=("$(printf 'ok    %-28s %5s ms  %s' "$LAST_NAME" "$LAST_MS" "$1")"); }

# check <js-condition> <message> [state]: asserts on the last output; "state"
# checks are skipped against a mock.
check() {
  [ "${3:-}" = state ] && [ "$MOCK" = 1 ] && return 0
  if [ "$(json "$1")" != "true" ]; then
    SUMMARY+=("$(printf 'FAIL  %-28s %5s  assertion failed: %s' "$LAST_NAME" '' "$2")")
    FAILED=$((FAILED + 1))
    return 1
  fi
}

CUS="" PROD="" PRICE=""

lifecycle() {
  run customers.create customers create --name "E2E $RUN_ID" --email "$RECIPIENT" || return 1
  CUS="$(json r.id)"; check 'r.id.startsWith("cus_")' "customer id" || return 1; ok "$CUS"

  run products.create products create --name "E2E product $RUN_ID" || return 1
  PROD="$(json r.id)"; check 'r.id.startsWith("prod_")' "product id" || return 1; ok "$PROD"

  run prices.create prices create --product "$PROD" --unit-amount 12345 --currency USD --nickname "$RUN_ID" || return 1
  PRICE="$(json r.id)"; check 'r.id.startsWith("price_")' "price id" || return 1
  check 'r.unit_amount === 12345 && r.currency === "USD"' "price echoes unit_amount and currency" state || return 1
  ok "$PRICE $(json r.unit_amount) $(json r.currency)"

  # Invoice 1: finalize → send → pay.
  run "invoices.create #1" invoices create --no-interactive --customer "$CUS" --currency USD --price "$PRICE" --qty 2 || return 1
  local inv; inv="$(json r.id)"
  check 'r.id.startsWith("in_")' "invoice id" || return 1
  check 'r.status === "draft"' "new invoice is draft" state || return 1
  check 'r.total === 24690' "total is 2 x 12345 = 24690" state || return 1
  ok "$inv $(json r.status) total=$(json r.total)"

  run "invoices.finalize #1" invoices finalize "$inv" || return 1
  check 'typeof r.number === "string" && r.number.length > 0' "finalized invoice has a number" || return 1
  check 'r.status === "open"' "finalized invoice is open" state || return 1
  ok "$(json r.number) $(json r.status)"

  run "invoices.send #1" invoices send "$inv" --to "$RECIPIENT" || return 1
  check "r.emailed_to === '$RECIPIENT'" "emailed_to is $RECIPIENT" state || return 1
  ok "emailed_to=$(json r.emailed_to)"

  run "invoices.pay #1" invoices pay "$inv" --reference "$RUN_ID" || return 1
  check 'r.status === "paid" && r.amount_due === 0' "invoice is paid" state || return 1
  ok "$(json r.status) amount_due=$(json r.amount_due)"

  # Invoice 2: finalize → void.
  run "invoices.create #2" invoices create --no-interactive --customer "$CUS" --currency USD --price "$PRICE" || return 1
  local inv2; inv2="$(json r.id)"
  check 'r.id.startsWith("in_")' "invoice id" || return 1
  ok "$inv2 $(json r.status)"

  run "invoices.finalize #2" invoices finalize "$inv2" || return 1
  ok "$(json r.number) $(json r.status)"

  run "invoices.void #2" invoices void "$inv2" --reason "E2E run $RUN_ID" || return 1
  check 'r.status === "void"' "invoice is void" state || return 1
  ok "$(json r.status)"
}

lifecycle || true

# Archive whatever was created, even after a failure, so the QA account stays tidy.
if [ -n "$PRICE" ] && run prices.archive prices archive "$PRICE"; then ok "active=$(json r.active)"; fi
if [ -n "$PROD" ] && run products.archive products archive "$PROD"; then ok "active=$(json r.active)"; fi
if [ -n "$CUS" ] && run "customers.archive" customers archive "$CUS"; then ok "deleted=$(json r.deleted)"; fi

printf '\nInvoice-AI e2e (CLI) run %s against %s%s\n' "$RUN_ID" "${INVOICE_AI_BASE_URL:-production}" "${MOCK:+ [mock]}"
printf '  %s\n' "${SUMMARY[@]}"
if [ "$FAILED" -gt 0 ]; then
  printf '\n%s step(s) failed.\n' "$FAILED"
  exit 1
fi
printf '\nAll %s steps passed.\n' "${#SUMMARY[@]}"
