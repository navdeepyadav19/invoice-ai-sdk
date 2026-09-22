"""
Contract test: every SDK method (sync and async) against a Prism mock of
api-docs/openapi.json.

    uv run pytest -m contract

Prism validates each request against the spec and reports problems in the
``sl-violations`` response header, so this catches the SDK sending a path,
query, header or body the API wouldn't accept. Responses come from the spec's
examples and must parse into the shape the SDK promises.

If Prism can't be downloaded or started (offline, no npx), the tests skip.
Mirrors packages/sdk-ts/test/contract/prism.test.ts.
"""

from __future__ import annotations

import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Callable, Dict, Iterator, List

import httpx
import pytest

from invoice_ai import OPERATIONS, AsyncInvoiceAI, AsyncPage, InvoiceAI, SyncPage
from invoice_ai._models import BaseModel

pytestmark = pytest.mark.contract

SPEC = Path(__file__).resolve().parents[4] / "api-docs" / "openapi.json"
KEY = "inv_live_ab12cd34_contractTestKey"

CUS = "cus_Nf3kQ8pR2mX7vB1cT9wL4sZ6"
PROD = "prod_Hy7Rq2Lm9Xc4Vb8Nt3Kd6Pw1"
PRICE = "price_Jc5Tn8Wq1Ze6Ra3Ym9Ub2Gs7"
INV = "in_Pb2Xk7Mv4Qs9Lr1Wd6Tn3Fh8"
II = "ii_Da4Vq9Ns2Kx7Bm3Yt8Rc1Lp6"
WE = "4f9c2a1e-7b3d-4e8a-9c6f-2d1b0a3e5f71"

# One representative call per operation (works for both clients: async ones return awaitables).
CALLS: Dict[str, Callable[[Any], Any]] = {
    "getBusiness": lambda c: c.business.retrieve(),
    "listCustomers": lambda c: c.customers.list(limit=2, query="acme"),
    "createCustomer": lambda c: c.customers.create(name="Acme Industries", email="ap@acme.example"),
    "retrieveCustomer": lambda c: c.customers.retrieve(CUS),
    "updateCustomer": lambda c: c.customers.update(CUS, phone="+1 512 555 0100"),
    "deleteCustomer": lambda c: c.customers.delete(CUS),
    "listProducts": lambda c: c.products.list(active=True),
    "createProduct": lambda c: c.products.create(name="Consulting retainer"),
    "retrieveProduct": lambda c: c.products.retrieve(PROD),
    "updateProduct": lambda c: c.products.update(PROD, name="Retainer"),
    "archiveProduct": lambda c: c.products.archive(PROD),
    "listPrices": lambda c: c.prices.list(product=PROD, currency="USD"),
    "createPrice": lambda c: c.prices.create(product=PROD, currency="USD", unit_amount=250000),
    "retrievePrice": lambda c: c.prices.retrieve(PRICE),
    "updatePrice": lambda c: c.prices.update(PRICE, active=False),
    "archivePrice": lambda c: c.prices.archive(PRICE),
    "listInvoices": lambda c: c.invoices.list(status="open", limit=5),
    "createInvoice": lambda c: c.invoices.create(customer=CUS, items=[{"price": PRICE, "quantity": 1}]),
    "retrieveInvoice": lambda c: c.invoices.retrieve(INV),
    "updateInvoice": lambda c: c.invoices.update(INV, customer=CUS, description="September retainer"),
    "deleteInvoice": lambda c: c.invoices.delete(INV),
    "finalizeInvoice": lambda c: c.invoices.finalize(INV),
    "sendInvoice": lambda c: c.invoices.send(INV, to="ap@acme.example"),
    "payInvoice": lambda c: c.invoices.pay(INV, reference="chk_123456"),
    "voidInvoice": lambda c: c.invoices.void(INV, reason="Duplicate"),
    "retrieveInvoicePdf": lambda c: c.invoices.pdf(INV),
    "listInvoiceEvents": lambda c: c.invoices.events(INV),
    "listInvoiceItems": lambda c: c.invoice_items.list(invoice=INV),
    "createInvoiceItem": lambda c: c.invoice_items.create(
        invoice=INV, description="Onboarding workshop", unit_amount=50000
    ),
    "retrieveInvoiceItem": lambda c: c.invoice_items.retrieve(II),
    "deleteInvoiceItem": lambda c: c.invoice_items.delete(II, invoice=INV),
    "listWebhookEndpoints": lambda c: c.webhook_endpoints.list(),
    "createWebhookEndpoint": lambda c: c.webhook_endpoints.create(
        url="https://example.com/hooks/invoice-ai", events=["invoice.paid"]
    ),
    "deleteWebhookEndpoint": lambda c: c.webhook_endpoints.delete(WE),
}


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


@pytest.fixture(scope="module")
def prism_url() -> Iterator[str]:
    npx = shutil.which("npx")
    if npx is None:
        pytest.skip("npx not found; skipping contract tests")
    port = _free_port()
    proc = subprocess.Popen(
        [npx, "--yes", "@stoplight/prism-cli@5", "mock", "--host", "127.0.0.1", "--port", str(port), "--errors", str(SPEC)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        shell=sys.platform == "win32",
    )
    url = f"http://127.0.0.1:{port}"
    deadline = time.monotonic() + 150
    try:
        while time.monotonic() < deadline:
            if proc.poll() is not None:
                pytest.skip("Prism exited; skipping contract tests")
            try:
                httpx.get(f"{url}/business", timeout=2)
                break  # any HTTP answer means it's listening
            except httpx.TransportError:
                time.sleep(0.5)
        else:
            pytest.skip("Prism did not start; skipping contract tests")
        yield url
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:  # pragma: no cover
            proc.kill()


violations: List[str] = []


def _record(response: httpx.Response) -> None:
    v = response.headers.get("sl-violations")
    if v:
        violations.append(f"{response.request.method} {response.request.url}: {v}")


async def _arecord(response: httpx.Response) -> None:
    _record(response)


def test_has_a_call_for_every_operation() -> None:
    assert sorted(CALLS) == sorted(o["operation_id"] for o in OPERATIONS)


def _strict(model: BaseModel) -> None:
    """The spec's example must fit the generated model without the lenient fallback."""
    type(model).model_validate(model.model_dump(mode="json", exclude_unset=True, by_alias=True))


def _check(kind: str, result: Any, page_cls: type) -> None:
    if isinstance(result, BaseModel):
        _strict(result)
    if kind == "page":
        assert isinstance(result, page_cls)
        assert isinstance(result.data, list)
        for item in result.data:
            _strict(item)
    elif kind == "data":
        assert isinstance(result, BaseModel)
        assert "data" not in (result.model_extra or {})  # unwrapped
    elif kind == "body":
        assert isinstance(result, BaseModel)
        assert getattr(result, "data", None) is not None
    elif kind == "binary":
        assert isinstance(result, bytes)
    elif kind == "void":
        assert result is None


@pytest.mark.parametrize("op", OPERATIONS, ids=[o["operation_id"] for o in OPERATIONS])
def test_sync(prism_url: str, op: Dict[str, Any]) -> None:
    http = httpx.Client(event_hooks={"response": [_record]})
    client = InvoiceAI(api_key=KEY, base_url=prism_url, http_client=http, max_retries=0, timeout=15)
    before = len(violations)
    result = CALLS[op["operation_id"]](client)
    assert violations[before:] == [], "Prism reported request violations"
    _check(op["kind"], result, SyncPage)
    http.close()


@pytest.mark.parametrize("op", OPERATIONS, ids=[o["operation_id"] for o in OPERATIONS])
async def test_async(prism_url: str, op: Dict[str, Any]) -> None:
    async with httpx.AsyncClient(event_hooks={"response": [_arecord]}) as http:
        client = AsyncInvoiceAI(api_key=KEY, base_url=prism_url, http_client=http, max_retries=0, timeout=15)
        before = len(violations)
        result = await CALLS[op["operation_id"]](client)
        assert violations[before:] == [], "Prism reported request violations"
        _check(op["kind"], result, AsyncPage)
