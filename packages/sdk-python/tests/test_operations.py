"""
Drift guard: every operationId in the published spec must be reachable as
``client.<resource>.<method>``, on both clients. If this fails after a spec
change, run ``pnpm sdk:gen`` from the repo root and commit the result.
"""

from __future__ import annotations

import inspect
import json
from pathlib import Path
from typing import Any, Dict, List

import pytest

from invoice_ai import API_VERSION, OPERATIONS, AsyncInvoiceAI, InvoiceAI, __version__

SPEC_PATH = Path(__file__).resolve().parents[3] / "api-docs" / "openapi.json"
SPEC: Dict[str, Any] = json.loads(SPEC_PATH.read_text())
SPEC_OPS: List[Dict[str, str]] = [
    {"operation_id": op["operationId"], "http_method": m.upper(), "path": path}
    for path, item in SPEC["paths"].items()
    for m, op in item.items()
    if m in ("get", "post", "patch", "put", "delete")
]

sync_client = InvoiceAI(api_key="inv_live_ab12cd34_x")
async_client = AsyncInvoiceAI(api_key="inv_live_ab12cd34_x")


@pytest.mark.parametrize("spec_op", SPEC_OPS, ids=[o["operation_id"] for o in SPEC_OPS])
def test_every_operation_has_a_sync_and_async_method(spec_op: Dict[str, str]) -> None:
    entry = next((o for o in OPERATIONS if o["operation_id"] == spec_op["operation_id"]), None)
    assert entry is not None, f"{spec_op['operation_id']} is missing from the generated manifest; run pnpm sdk:gen"
    assert entry["http_method"] == spec_op["http_method"]
    assert entry["path"] == spec_op["path"]

    sync_method = getattr(getattr(sync_client, entry["resource"]), entry["method"])
    async_method = getattr(getattr(async_client, entry["resource"]), entry["method"])
    assert callable(sync_method)
    assert callable(async_method)
    # Async methods are coroutines, except list-style methods, which return an awaitable, async-iterable page.
    if entry["kind"] == "page":
        assert not inspect.iscoroutinefunction(async_method)
    else:
        assert inspect.iscoroutinefunction(async_method)
    assert not inspect.iscoroutinefunction(sync_method)

    # Raw-response views expose the same methods.
    assert callable(getattr(getattr(sync_client, entry["resource"]).with_raw_response, entry["method"]))
    assert callable(getattr(getattr(async_client, entry["resource"]).with_raw_response, entry["method"]))


def test_the_manifest_has_nothing_the_spec_lacks() -> None:
    assert sorted(o["operation_id"] for o in OPERATIONS) == sorted(o["operation_id"] for o in SPEC_OPS)


def test_method_names_are_unique_per_resource_and_follow_the_verb_conventions() -> None:
    keys = [f"{o['resource']}.{o['method']}" for o in OPERATIONS]
    assert len(set(keys)) == len(keys)
    allowed = {"create", "retrieve", "update", "list", "delete", "archive", "finalize", "send", "pay", "void", "pdf", "events"}
    for o in OPERATIONS:
        assert o["method"] in allowed, f"{o['operation_id']} → {o['method']}"


def test_path_params_come_first_and_everything_else_is_keyword_only() -> None:
    for o in OPERATIONS:
        sig = inspect.signature(getattr(getattr(sync_client, o["resource"]), o["method"]))
        positional = [p.name for p in sig.parameters.values() if p.kind is inspect.Parameter.POSITIONAL_OR_KEYWORD]
        assert positional == [seg[1:-1] for seg in o["path"].split("/") if seg.startswith("{")], o["operation_id"]
        for name in ("idempotency_key", "timeout", "max_retries", "extra_headers"):
            assert sig.parameters[name].kind is inspect.Parameter.KEYWORD_ONLY


def test_versions() -> None:
    pyproject = (Path(__file__).resolve().parents[1] / "pyproject.toml").read_text()
    assert f'version = "{__version__}"' in pyproject
    assert SPEC["info"]["version"] == API_VERSION
