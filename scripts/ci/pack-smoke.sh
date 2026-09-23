#!/usr/bin/env bash
# Package install smoke test: install what we would publish, the way a user would.
#
#   scripts/ci/pack-smoke.sh            # npm packages, then the Python package
#   scripts/ci/pack-smoke.sh node       # only @horizonpay/invoice-ai + @horizonpay/invoice-ai-cli
#   scripts/ci/pack-smoke.sh python     # only horizonpay-invoice-ai (see pack-smoke-python.sh)
#
# npm part:
#   1. Build the TS SDK and the CLI fresh (a stale dist/ must never be what we test).
#   2. `pnpm pack` each. pnpm rewrites `workspace:` ranges at pack/publish time;
#      fail if the CLI tarball still depends on the SDK through anything that
#      isn't a real semver range.
#   3. Inspect the tarballs: required dist files, the CLI's shebang, no `workspace:`
#      anywhere, and LICENSE present whenever package.json `files` lists it.
#   4. In a blank temp project: `npm init -y && npm i <sdk.tgz> <cli.tgz>` (no
#      workspace, no pnpm symlinks), then:
#        - ESM: default and named `InvoiceAI` imports are both constructors;
#        - CJS: `require()` exposes `InvoiceAI` as a constructor;
#        - `npx invoice-ai --help` exits 0, `--version` prints the package version.
#   5. publint on both tarballs, and @arethetypeswrong/cli on the SDK tarball.
#      attw currently reports no problems on any resolution mode, so ANY attw
#      problem fails the job. If a future build change makes an intentional,
#      understood trade-off (e.g. tsup `cjsInterop` producing a CJS default
#      shape attw flags as "false-export-default"), pass the rule through
#      ATTW_IGNORE_RULES="false-export-default" and document why at the call site.
#
# Env:
#   PACK_SMOKE_SKIP_BUILD=1   reuse the existing dist/ (CI builds in an earlier step)
#   PACK_SMOKE_DIR=<dir>      where to put tarballs and the temp project (default: mktemp)
#   ATTW_IGNORE_RULES="..."   space-separated attw rules to ignore (default: none)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PART="${1:-all}"
WORK="${PACK_SMOKE_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/pack-smoke.XXXXXX")}"
mkdir -p "$WORK"

PUBLINT="publint@0.3"
ATTW="@arethetypeswrong/cli@0.18"

log() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
ok() { printf '  ok  %s\n' "$*"; }
fail() {
  printf '  FAIL %s\n' "$*" >&2
  [ -n "${GITHUB_ACTIONS:-}" ] && printf '::error::pack-smoke: %s\n' "$*"
  exit 1
}

# Reads a field from a package.json with node (no jq dependency).
pkg_field() { node -e "const p=require(process.argv[1]); const v=process.argv[2].split('.').reduce((o,k)=>o==null?o:o[k],p); process.stdout.write(v==null?'':typeof v==='string'?v:JSON.stringify(v))" "$1" "$2"; }

# pnpm pack into an empty dir and print the single tarball's path.
pack() {
  local dir="$1" dest="$2"
  rm -rf "$dest" && mkdir -p "$dest"
  (cd "$dir" && pnpm pack --pack-destination "$dest" >/dev/null)
  local tgz
  tgz=$(ls "$dest"/*.tgz)
  [ "$(echo "$tgz" | wc -l | tr -d ' ')" = 1 ] || fail "expected one tarball in $dest, got: $tgz"
  echo "$tgz"
}

# Asserts on a tarball's file list and its (rewritten) package.json.
check_tarball() {
  local tgz="$1" label="$2"; shift 2
  local listing
  listing=$(tar -tzf "$tgz")
  for f in package/package.json package/README.md "$@"; do
    grep -qx "$f" <<<"$listing" || fail "$label tarball is missing $f"
  done
  ok "$label tarball has package.json, README.md $*"

  local pj="$WORK/$label.package.json"
  tar -xOzf "$tgz" package/package.json >"$pj"
  if grep -q '"workspace:' "$pj"; then fail "$label tarball package.json still contains a workspace: range"; fi
  ok "$label tarball package.json has no workspace: ranges"

  # LICENSE: only required once the package opts in through `files`, so this
  # check runs today and starts enforcing when the metadata change lands.
  if node -e "const f=require(process.argv[1]).files||[]; process.exit(f.some(x=>/^LICEN[SC]E/i.test(x))?0:1)" "$pj"; then
    grep -qiE '^package/LICEN[SC]E(\.md|\.txt)?$' <<<"$listing" || fail "$label lists LICENSE in files but the tarball has none"
    ok "$label tarball ships LICENSE"
  else
    ok "$label does not list LICENSE in files yet (not enforced)"
  fi

  if grep -qE '^package/(src|test)/' <<<"$listing"; then fail "$label tarball ships src/ or test/"; fi
  ok "$label tarball ships no src/ or test/"
}

node_part() {
  local sdk_dir="$ROOT/packages/sdk-ts" cli_dir="$ROOT/packages/cli"
  local sdk_version cli_version
  sdk_version=$(pkg_field "$sdk_dir/package.json" version)
  cli_version=$(pkg_field "$cli_dir/package.json" version)

  if [ -z "${PACK_SMOKE_SKIP_BUILD:-}" ]; then
    log "Building @horizonpay/invoice-ai and @horizonpay/invoice-ai-cli"
    (cd "$ROOT" && pnpm --filter @horizonpay/invoice-ai build >/dev/null && pnpm --filter @horizonpay/invoice-ai-cli build >/dev/null)
    ok "built"
  fi

  log "Packing"
  local sdk_tgz cli_tgz
  sdk_tgz=$(pack "$sdk_dir" "$WORK/tarballs/sdk")
  cli_tgz=$(pack "$cli_dir" "$WORK/tarballs/cli")
  ok "$(basename "$sdk_tgz")"
  ok "$(basename "$cli_tgz")"

  log "Inspecting tarballs"
  check_tarball "$sdk_tgz" sdk package/dist/index.js package/dist/index.cjs package/dist/index.d.ts package/dist/index.d.cts
  check_tarball "$cli_tgz" cli package/dist/index.js

  local dep
  dep=$(pkg_field "$WORK/cli.package.json" 'dependencies.@horizonpay/invoice-ai')
  [ -n "$dep" ] || fail "CLI tarball does not depend on @horizonpay/invoice-ai"
  [[ "$dep" =~ ^[\^~]?[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] ||
    fail "CLI tarball depends on @horizonpay/invoice-ai@'$dep', not a semver range (publish with pnpm, which rewrites workspace:)"
  ok "CLI depends on @horizonpay/invoice-ai@$dep"

  [[ "$(tar -xOzf "$cli_tgz" package/dist/index.js | sed -n 1p)" == "#!/usr/bin/env node"* ]] || fail "CLI dist/index.js has no node shebang"
  ok "CLI binary has a node shebang"

  log "Installing both tarballs into a blank npm project"
  local app="$WORK/consumer"
  rm -rf "$app" && mkdir -p "$app"
  (
    cd "$app"
    npm init -y >/dev/null
    # If the CLI's SDK range didn't match the local SDK tarball, npm would go to
    # the registry for it; `npm ls` below then shows the mismatch.
    npm install --no-audit --no-fund --loglevel=error "$sdk_tgz" "$cli_tgz" >/dev/null
  )
  ok "npm install succeeded"
  local resolved
  resolved=$(cd "$app" && node -p "require('./node_modules/@horizonpay/invoice-ai/package.json').version")
  [ "$resolved" = "$sdk_version" ] || fail "installed SDK is $resolved, expected the packed $sdk_version"
  if [ -d "$app/node_modules/@horizonpay/invoice-ai-cli/node_modules/@horizonpay/invoice-ai" ]; then
    fail "the CLI installed its own nested copy of the SDK instead of the packed one (range $dep vs $sdk_version)"
  fi
  ok "CLI uses the packed SDK $sdk_version (deduped)"

  log "Importing the SDK (ESM and CJS)"
  cat >"$app/esm.mjs" <<'JS'
import InvoiceAI, { InvoiceAI as Named, VERSION } from '@horizonpay/invoice-ai'
if (typeof InvoiceAI !== 'function') throw new Error(`default export is ${typeof InvoiceAI}`)
if (typeof Named !== 'function') throw new Error(`named InvoiceAI is ${typeof Named}`)
if (InvoiceAI !== Named) throw new Error('default and named InvoiceAI differ')
const client = new InvoiceAI({ apiKey: 'inv_test_smoke_0000' })
if (!client.invoices || typeof client.invoices.create !== 'function') throw new Error('client.invoices.create missing')
console.log(`esm ok (VERSION ${VERSION})`)
JS
  cat >"$app/cjs.cjs" <<'JS'
const { InvoiceAI, VERSION } = require('@horizonpay/invoice-ai')
if (typeof InvoiceAI !== 'function') throw new Error(`require().InvoiceAI is ${typeof InvoiceAI}`)
const client = new InvoiceAI({ apiKey: 'inv_test_smoke_0000' })
if (!client.customers || typeof client.customers.create !== 'function') throw new Error('client.customers.create missing')
console.log(`cjs ok (VERSION ${VERSION})`)
JS
  (cd "$app" && node esm.mjs && node cjs.cjs) | sed 's/^/  ok  /'

  log "Running the installed CLI"
  (
    cd "$app"
    export INVOICE_AI_NO_UPDATE_CHECK=1 NO_COLOR=1
    npx --no-install invoice-ai --help >/dev/null || fail "invoice-ai --help exited non-zero"
    ok "invoice-ai --help exits 0"
    local v
    v=$(npx --no-install invoice-ai --version)
    [[ "$v" == *"$cli_version"* ]] || fail "invoice-ai --version printed '$v', expected $cli_version"
    ok "invoice-ai --version prints $v"
  )

  log "publint"
  (cd "$WORK" && npx -y "$PUBLINT" run --strict "$sdk_tgz") || fail "publint reported problems in the SDK"
  (cd "$WORK" && npx -y "$PUBLINT" run --strict "$cli_tgz") || fail "publint reported problems in the CLI"
  ok "publint clean on both packages"

  log "Are the types wrong? (SDK)"
  local attw_args=()
  # shellcheck disable=SC2206 # word splitting is intended
  [ -n "${ATTW_IGNORE_RULES:-}" ] && attw_args=(--ignore-rules ${ATTW_IGNORE_RULES})
  (cd "$WORK" && npx -y "$ATTW" "$sdk_tgz" --format table --no-emoji --no-color ${attw_args[@]+"${attw_args[@]}"}) ||
    fail "attw reported type problems in the SDK"
  ok "attw clean${ATTW_IGNORE_RULES:+ (ignoring: $ATTW_IGNORE_RULES)}"
}

case "$PART" in
  node) node_part ;;
  python) bash "$ROOT/scripts/ci/pack-smoke-python.sh" "$WORK/python" ;;
  all)
    node_part
    bash "$ROOT/scripts/ci/pack-smoke-python.sh" "$WORK/python"
    ;;
  *) echo "usage: $0 [node|python|all]" >&2; exit 2 ;;
esac

log "Package install smoke passed ($PART). Work dir: $WORK"
