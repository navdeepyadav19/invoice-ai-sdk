#!/usr/bin/env bash
# Python half of the package install smoke test (called by pack-smoke.sh, or alone):
#
#   scripts/ci/pack-smoke-python.sh [work-dir]
#
#   1. `uv build` a fresh sdist + wheel of packages/sdk-python.
#   2. `twine check` both (the long description must render on PyPI).
#   3. Inspect the wheel: py.typed ships, no tests/, and a license file whenever
#      pyproject.toml declares `license-files` (enforced only once it does).
#   4. Install the wheel into a brand-new venv (not the project env) and import
#      it: `invoice_ai.__version__` must equal invoice_ai/_version.py, and the
#      client must construct.
#   5. Install the sdist into another new venv too, so a source install works.
#
# Needs uv (https://docs.astral.sh/uv/). Uses the default Python uv finds, or
# PACK_SMOKE_PYTHON (e.g. 3.13).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PKG="$ROOT/packages/sdk-python"
WORK="${1:-$(mktemp -d "${TMPDIR:-/tmp}/pack-smoke-py.XXXXXX")}"
PY_ARGS=()
[ -n "${PACK_SMOKE_PYTHON:-}" ] && PY_ARGS=(--python "$PACK_SMOKE_PYTHON")

log() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
ok() { printf '  ok  %s\n' "$*"; }
fail() {
  printf '  FAIL %s\n' "$*" >&2
  [ -n "${GITHUB_ACTIONS:-}" ] && printf '::error::pack-smoke (python): %s\n' "$*"
  exit 1
}

command -v uv >/dev/null || fail "uv is not installed"

expected=$(sed -nE 's/^__version__ = "([^"]+)"/\1/p' "$PKG/invoice_ai/_version.py")
[ -n "$expected" ] || fail "could not read __version__ from invoice_ai/_version.py"

log "Building horizonpay-invoice-ai $expected"
rm -rf "$WORK" && mkdir -p "$WORK/dist"
(cd "$PKG" && uv build --quiet --out-dir "$WORK/dist" ${PY_ARGS[@]+"${PY_ARGS[@]}"})
wheel=$(ls "$WORK"/dist/*.whl)
sdist=$(ls "$WORK"/dist/*.tar.gz)
ok "$(basename "$wheel")"
ok "$(basename "$sdist")"
[[ "$(basename "$wheel")" == horizonpay_invoice_ai-"$expected"-* ]] || fail "wheel version does not match _version.py ($expected)"
ok "wheel version matches _version.py"

log "twine check"
uvx --quiet twine check --strict "$WORK"/dist/* || fail "twine check failed"
ok "twine check passed"

log "Inspecting the wheel"
listing=$(python3 -c 'import sys, zipfile; print("\n".join(zipfile.ZipFile(sys.argv[1]).namelist()))' "$wheel")
grep -qx 'invoice_ai/py.typed' <<<"$listing" || fail "wheel is missing invoice_ai/py.typed"
ok "ships invoice_ai/py.typed"
if grep -qE '^tests/' <<<"$listing"; then fail "wheel ships tests/"; fi
ok "ships no tests/"
if grep -qE '^\s*license-files\s*=' "$PKG/pyproject.toml"; then
  grep -qiE '\.dist-info/licenses/.*LICEN[SC]E' <<<"$listing" || fail "pyproject declares license-files but the wheel has no license"
  ok "ships its license file"
else
  ok "pyproject has no license-files yet (not enforced)"
fi

install_and_import() {
  local what="$1" artifact="$2" venv="$WORK/venv-$1"
  uv venv --quiet ${PY_ARGS[@]+"${PY_ARGS[@]}"} "$venv"
  uv pip install --quiet --python "$venv/bin/python" "$artifact"
  local got
  got=$(cd "$WORK" && "$venv/bin/python" - <<'PY'
import sys

import invoice_ai
from invoice_ai import InvoiceAI

client = InvoiceAI(api_key="inv_test_smoke_0000")
assert callable(client.invoices.create), "client.invoices.create missing"
assert invoice_ai.__file__ and "site-packages" in invoice_ai.__file__, invoice_ai.__file__
print(invoice_ai.__version__, f"(Python {sys.version.split()[0]})")
PY
  ) || fail "importing invoice_ai from the $what failed"
  [[ "$got" == "$expected "* ]] || fail "$what reports __version__ $got, expected $expected"
  ok "$what: import invoice_ai -> $got"
}

log "Installing into fresh venvs"
install_and_import wheel "$wheel"
install_and_import sdist "$sdist"

log "Python package smoke passed. Work dir: $WORK"
