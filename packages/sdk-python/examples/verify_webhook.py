"""
A minimal webhook receiver (standard library only) that verifies each delivery.

    INVOICE_AI_WEBHOOK_SECRET=whsec_… uv run python examples/verify_webhook.py

Then register http(s)://…/webhooks/invoice-ai with
`client.webhook_endpoints.create(url=..., events=["invoice.paid"])`.
Verify the RAW body: a re-serialised JSON body won't match the signature.
"""

from __future__ import annotations

import os
from http.server import BaseHTTPRequestHandler, HTTPServer

from invoice_ai import Webhook, WebhookVerificationError, format_money

webhook = Webhook(os.environ["INVOICE_AI_WEBHOOK_SECRET"])
seen: set[str] = set()


class Handler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        raw = self.rfile.read(int(self.headers.get("content-length", 0)))
        try:
            event = webhook.verify(raw, dict(self.headers.items()))
        except WebhookVerificationError as e:
            self.send_response(400)
            self.end_headers()
            self.wfile.write(str(e).encode())
            return

        # Deliveries can repeat; the event id is stable across retries.
        if event.id not in seen:
            seen.add(event.id)
            invoice = event.data.object
            if event.type == "invoice.paid":
                print(f"{invoice.number} paid: {format_money(invoice.total, invoice.currency)}")
            else:
                print(f"{event.type}: {invoice.id}")

        self.send_response(204)
        self.end_headers()


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "4242"))
    print(f"Listening on http://localhost:{port}/webhooks/invoice-ai")
    HTTPServer(("", port), Handler).serve_forever()
