"""
Create a customer, bill them from the catalog, finalize and email the invoice.

    INVOICE_AI_API_KEY=inv_live_… uv run python examples/create_and_send_invoice.py

Point INVOICE_AI_BASE_URL at http://localhost:3000/api/v1 to try it locally.
"""

from __future__ import annotations

from invoice_ai import InvalidStateError, InvoiceAI, ValidationError, format_money, to_minor


def main() -> None:
    client = InvoiceAI()  # reads INVOICE_AI_API_KEY

    customer = client.customers.create(name="Acme Industries", email="delivered@resend.dev")
    product = client.products.create(name="Consulting retainer")
    price = client.prices.create(product=product.id, currency="USD", unit_amount=to_minor("2500.00", "USD"))

    try:
        draft = client.invoices.create(
            customer=customer.id,
            items=[
                {"price": price.id, "quantity": 1},
                {"description": "Onboarding workshop", "unit_amount": to_minor("500", "USD")},
            ],
            days_until_due=30,
        )
    except ValidationError as e:
        for field in e.fields:
            print(f"  {field['path']}: {field['message']}")
        raise

    invoice = client.invoices.finalize(draft.id)
    print(f"Finalized {invoice.number}: {format_money(invoice.total, invoice.currency)}")

    try:
        sent = client.invoices.send(invoice.id)
        print(f"Emailed to {sent.emailed_to}")
    except InvalidStateError as e:
        print(f"Could not send ({e.code}): {e.detail} — request {e.request_id}")

    # Every open invoice, across all pages.
    for inv in client.invoices.list(status="open"):
        print(inv.number, format_money(inv.amount_due, inv.currency))


if __name__ == "__main__":
    main()
