"""
Live end-to-end lifecycle through the Python SDK (opt-in; never runs on PRs).

    INVOICE_AI_E2E_KEY=inv_live_... uv run --project packages/sdk-python python scripts/e2e/lifecycle.py

customer -> product + USD price -> invoice (with the price) -> finalize -> send
(to delivered@resend.dev) -> pay; a second invoice -> finalize -> void; then
archive the price, product and customer. Prints a compact summary and exits
non-zero on any failure. Cleanup (archiving) runs even when a step fails.

Env:
    INVOICE_AI_E2E_KEY     API key of the QA account (required)
    INVOICE_AI_BASE_URL    API base URL (default: production)
    INVOICE_AI_E2E_MOCK=1  running against a Prism mock: its responses are static
                           examples, so only response shapes are checked, not
                           state transitions (status, ids echoed back)
"""

from __future__ import annotations

import contextlib
import os
import random
import string
import sys
import time
import traceback
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Callable, TypeVar

from invoice_ai import InvoiceAI

RECIPIENT = "delivered@resend.dev"
MOCK = os.environ.get("INVOICE_AI_E2E_MOCK") == "1"

T = TypeVar("T")


@dataclass
class Step:
    name: str
    ok: bool
    ms: int
    detail: str


steps: list[Step] = []


def step(name: str, fn: Callable[[], T], describe: Callable[[T], str] = lambda _: "") -> T:
    start = time.monotonic()
    try:
        result = fn()
    except Exception as err:
        steps.append(Step(name, False, int((time.monotonic() - start) * 1000), f"{type(err).__name__}: {err}"))
        err.__dict__["_e2e_recorded"] = True
        raise
    steps.append(Step(name, True, int((time.monotonic() - start) * 1000), describe(result)))
    return result


def expect(cond: object, message: str) -> None:
    if not cond:
        raise AssertionError(f"assertion failed: {message}")


def expect_state(cond: object, message: str) -> None:
    """A state assertion: skipped against a mock, whose responses never change."""
    if not MOCK:
        expect(cond, message)


def print_summary(run_id: str, base_url: str) -> bool:
    failed = sum(1 for s in steps if not s.ok)
    width = max(len(s.name) for s in steps)
    print(f"\nInvoice-AI e2e (Python SDK) run {run_id} against {base_url}{' [mock]' if MOCK else ''}")
    for s in steps:
        print(f"  {'ok  ' if s.ok else 'FAIL'}  {s.name.ljust(width)}  {s.ms:>5} ms  {s.detail}")
    print(f"\n{failed} step(s) failed." if failed else f"\nAll {len(steps)} steps passed.")
    return failed == 0


def main() -> int:
    api_key = os.environ.get("INVOICE_AI_E2E_KEY")
    if not api_key:
        print("INVOICE_AI_E2E_KEY is not set; nothing to do.", file=sys.stderr)
        return 2
    base_url = os.environ.get("INVOICE_AI_BASE_URL") or None
    client = InvoiceAI(api_key=api_key, base_url=base_url, max_retries=2)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
    run_id = f"e2e-py-{stamp}-{''.join(random.choices(string.ascii_lowercase + string.digits, k=4))}"

    created: dict[str, str] = {}
    failure: BaseException | None = None
    try:
        customer = step(
            "customers.create", lambda: client.customers.create(name=f"E2E {run_id}", email=RECIPIENT), lambda c: c.id
        )
        created["customer"] = customer.id
        expect(customer.id.startswith("cus_"), f"customer id {customer.id}")

        product = step("products.create", lambda: client.products.create(name=f"E2E product {run_id}"), lambda p: p.id)
        created["product"] = product.id
        expect(product.id.startswith("prod_"), f"product id {product.id}")

        price = step(
            "prices.create",
            lambda: client.prices.create(product=product.id, unit_amount=12345, currency="USD", nickname=run_id),
            lambda p: f"{p.id} {p.unit_amount} {p.currency}",
        )
        created["price"] = price.id
        expect(price.id.startswith("price_"), f"price id {price.id}")
        expect_state(price.unit_amount == 12345 and price.currency == "USD", "price echoes unit_amount and currency")

        # Invoice 1: finalize -> send -> pay.
        inv = step(
            "invoices.create #1",
            lambda: client.invoices.create(
                customer=customer.id, currency="USD", items=[{"price": price.id, "quantity": 2}]
            ),
            lambda i: f"{i.id} {i.status} total={i.total}",
        )
        expect(inv.id.startswith("in_"), f"invoice id {inv.id}")
        expect_state(inv.status == "draft", f"new invoice is draft, got {inv.status}")
        expect_state(inv.total == 24690, f"total is 2 x 12345 = 24690, got {inv.total}")

        fin = step("invoices.finalize #1", lambda: client.invoices.finalize(inv.id), lambda i: f"{i.number} {i.status}")
        expect(bool(fin.number), "finalized invoice has a number")
        expect_state(fin.status == "open", f"finalized invoice is open, got {fin.status}")

        sent = step(
            "invoices.send #1",
            lambda: client.invoices.send(inv.id, to=RECIPIENT),
            lambda r: f"emailed_to={r.emailed_to}",
        )
        expect_state(sent.emailed_to == RECIPIENT, f"emailed_to {sent.emailed_to}")

        paid = step(
            "invoices.pay #1",
            lambda: client.invoices.pay(inv.id, reference=run_id),
            lambda i: f"{i.status} amount_due={i.amount_due}",
        )
        expect_state(
            paid.status == "paid" and paid.amount_due == 0, f"paid invoice, got {paid.status} / {paid.amount_due}"
        )

        # Invoice 2: finalize -> void.
        inv2 = step(
            "invoices.create #2",
            lambda: client.invoices.create(customer=customer.id, currency="USD", items=[{"price": price.id}]),
            lambda i: f"{i.id} {i.status}",
        )
        expect(inv2.id.startswith("in_"), f"invoice id {inv2.id}")
        step("invoices.finalize #2", lambda: client.invoices.finalize(inv2.id), lambda i: f"{i.number} {i.status}")
        voided = step(
            "invoices.void #2",
            lambda: client.invoices.void(inv2.id, reason=f"E2E run {run_id}"),
            lambda i: f"{i.status}",
        )
        expect_state(voided.status == "void", f"voided invoice, got {voided.status}")
    except Exception as err:
        failure = err
        if not getattr(err, "_e2e_recorded", False):
            # An assertion on the previous step's response, not a failed request.
            last = steps[-1].name if steps else "start"
            steps.append(Step(f"  check after {last}", False, 0, str(err)))
    finally:
        # Archive whatever was created, even after a failure, so the QA account stays tidy.
        def cleanup(name: str, fn: Callable[[], T], describe: Callable[[T], str]) -> None:
            # A failure is recorded as a failed step; keep archiving the rest.
            with contextlib.suppress(Exception):
                step(name, fn, describe)

        if "price" in created:
            cleanup("prices.archive", lambda: client.prices.archive(created["price"]), lambda p: f"active={p.active}")
        if "product" in created:
            cleanup(
                "products.archive", lambda: client.products.archive(created["product"]), lambda p: f"active={p.active}"
            )
        if "customer" in created:
            cleanup(
                "customers.delete (archive)",
                lambda: client.customers.delete(created["customer"]),
                lambda c: f"deleted={c.deleted}",
            )

    ok = print_summary(run_id, client.base_url)
    if failure is not None:
        print("\nFirst failure:", file=sys.stderr)
        traceback.print_exception(type(failure), failure, failure.__traceback__, file=sys.stderr)
    return 0 if ok and failure is None else 1


if __name__ == "__main__":
    sys.exit(main())
