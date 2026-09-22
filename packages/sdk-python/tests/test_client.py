"""Configuration, the escape hatch, resource shapes and redacted logging. Mirrors client.test.ts."""

from __future__ import annotations

import logging

import httpx
import pytest
import respx
from helpers import API_KEY, BASE, FakeServer, async_client, client, customer, json_response, problem

from invoice_ai import DEFAULT_BASE_URL, AsyncInvoiceAI, InvoiceAI, InvoiceAIError, types
from invoice_ai._logging import redact_api_key, redact_headers, redact_secrets


class TestConfiguration:
    def test_reads_invoice_ai_api_key_and_base_url(self, router: respx.MockRouter, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("INVOICE_AI_API_KEY", API_KEY)
        monkeypatch.setenv("INVOICE_AI_BASE_URL", "http://localhost:3000/api/v1")
        route = router.get("http://localhost:3000/api/v1/business").mock(
            return_value=json_response(200, {"data": {"id": "biz"}})
        )
        InvoiceAI().business.retrieve()
        assert route.calls[0].request.headers["authorization"] == f"Bearer {API_KEY}"

    def test_defaults_to_the_production_base_url(self) -> None:
        assert InvoiceAI(api_key=API_KEY).base_url == DEFAULT_BASE_URL

    def test_fails_early_without_a_key_or_with_a_malformed_one(self) -> None:
        with pytest.raises(InvoiceAIError, match="INVOICE_AI_API_KEY"):
            InvoiceAI()
        with pytest.raises(InvoiceAIError, match="inv_live_"):
            InvoiceAI(api_key="sk_test_123")
        with pytest.raises(InvoiceAIError):
            AsyncInvoiceAI()

    def test_never_shows_the_key_in_repr(self) -> None:
        c = InvoiceAI(api_key=API_KEY)
        assert API_KEY not in repr(c)
        assert "inv_live_ab12cd34…" in repr(c)

    def test_refuses_empty_path_params(self) -> None:
        with pytest.raises(InvoiceAIError, match="`id` must be a non-empty string"):
            client().customers.retrieve("")
        with pytest.raises(InvoiceAIError, match="`id` must be a non-empty string, got NoneType"):
            client().customers.retrieve(None)  # type: ignore[arg-type]

    def test_uses_an_injected_http_client_and_default_headers(self, router: respx.MockRouter) -> None:
        server = FakeServer(router, json_response(200, {"data": customer("cus_1")}))
        http = httpx.Client(headers={"x-from-http-client": "1"})
        c = client(http_client=http, default_headers={"X-Team": "billing"})
        c.customers.retrieve("cus_1", extra_headers={"X-Trace": "t1"})
        h = server.calls[0].headers
        assert (h["x-from-http-client"], h["x-team"], h["x-trace"]) == ("1", "billing", "t1")
        c.close()
        assert not http.is_closed  # we don't close what we didn't open

    def test_context_managers_close_the_client(self) -> None:
        with InvoiceAI(api_key=API_KEY) as c:
            pass
        assert c._http.is_closed

    async def test_async_context_manager(self) -> None:
        async with AsyncInvoiceAI(api_key=API_KEY) as c:
            pass
        assert c._http.is_closed


class TestEscapeHatch:
    def test_returns_the_raw_body_with_the_same_retries_idempotency_and_errors(self, router: respx.MockRouter) -> None:
        server = FakeServer(router, problem(503, "upstream_failed"), json_response(200, {"data": {"id": "x"}, "extra": 1}))
        body = client().request("POST", "/things", body={"a": 1}, query={"dry_run": True})
        assert body == {"data": {"id": "x"}, "extra": 1}
        assert len(server.calls) == 2
        assert server.calls[0].url.query == b"dry_run=true"
        assert server.calls[0].headers["idempotency-key"] == server.calls[1].headers["idempotency-key"]

    async def test_async_escape_hatch(self, router: respx.MockRouter) -> None:
        FakeServer(router, json_response(200, {"data": {"id": "biz"}}))
        assert await async_client().request("GET", "/business") == {"data": {"id": "biz"}}


class TestResourceMethods:
    def test_unwrap_data_into_models(self, router: respx.MockRouter) -> None:
        FakeServer(router, json_response(200, {"data": customer("cus_9")}))
        c = client().customers.retrieve("cus_9")
        assert isinstance(c, types.Customer)
        assert c.to_dict() == customer("cus_9")

    def test_body_responses_keep_extra_fields(self, router: respx.MockRouter) -> None:
        inv = {"id": "in_1", "object": "invoice", "status": "open"}
        FakeServer(router, json_response(200, {"data": inv, "emailed_to": "ap@acme.example"}))
        res = client().invoices.send("in_1", to="ap@acme.example")
        assert isinstance(res, types.InvoiceSendResponse)
        assert res.emailed_to == "ap@acme.example"
        assert res.data.id == "in_1"

    def test_parses_leniently_when_the_api_sends_something_new(self, router: respx.MockRouter) -> None:
        odd = {**customer("cus_1"), "object": "customer_v2", "brand_new": True}
        FakeServer(router, json_response(200, {"data": odd}))
        c = client().customers.retrieve("cus_1")
        assert c.id == "cus_1"
        assert c.object == "customer_v2"

    def test_split_query_and_body_for_action_endpoints(self, router: respx.MockRouter) -> None:
        server = FakeServer(router, json_response(200, {"data": {"id": "in_1"}}))
        client().invoices.void("in_1", reason="Duplicate")
        assert server.calls[0].url.path == "/api/v1/invoices/in_1/void"
        assert server.calls[0].body == {"reason": "Duplicate"}

    def test_nested_params_accept_dicts_and_models(self, router: respx.MockRouter) -> None:
        server = FakeServer(router, json_response(201, {"data": {"id": "in_1"}}))
        client().invoices.create(
            customer="cus_1",
            items=[{"price": "price_1", "quantity": 2}, types.InvoiceLineInput(description="Setup", unit_amount=5000)],
        )
        assert server.calls[0].body == {
            "customer": "cus_1",
            "items": [{"price": "price_1", "quantity": 2}, {"description": "Setup", "unit_amount": 5000}],
        }

    def test_optional_bodies_are_omitted_when_empty(self, router: respx.MockRouter) -> None:
        server = FakeServer(router, json_response(200, {"data": {"id": "in_1"}}))
        client().invoices.pay("in_1")
        client().invoices.pay("in_1", reference="chk_1")
        assert server.calls[0].body is None
        assert server.calls[1].body == {"reference": "chk_1"}

    def test_pdf_url_builds_an_absolute_url(self) -> None:
        assert client().invoices.pdf_url("in_1", download="1") == f"{BASE}/invoices/in_1/pdf?download=1"
        assert async_client().invoices.pdf_url("in_1") == f"{BASE}/invoices/in_1/pdf"


class TestLoggingAndRedaction:
    def test_logs_method_path_status_request_id_and_retries_never_the_key(
        self, router: respx.MockRouter, caplog: pytest.LogCaptureFixture
    ) -> None:
        FakeServer(router, problem(500, "internal_error"), json_response(201, {"data": customer("cus_1")}))
        with caplog.at_level(logging.DEBUG, logger="invoice_ai"):
            client(log_level="debug").customers.create(name="Acme")
        out = "\n".join(r.getMessage() for r in caplog.records)
        assert "→ POST /api/v1/customers" in out
        assert "← 500 POST /api/v1/customers (req_err42" in out
        assert "retrying POST /api/v1/customers in" in out
        assert "(attempt 2 of 3) after 500 internal_error" in out
        assert "← 201 POST /api/v1/customers (req_test123" in out
        assert "Bearer inv_live_ab12cd34…" in out
        assert API_KEY not in out
        assert "7Kf9QmXz2pR4vNt6LwYb8HsJ3dGc5eAu" not in out

    def test_logs_nothing_below_the_chosen_level(self, router: respx.MockRouter, caplog: pytest.LogCaptureFixture) -> None:
        FakeServer(router, json_response(200, {"data": customer("cus_1")}))
        with caplog.at_level(logging.DEBUG, logger="invoice_ai"):
            client(log_level="warn").customers.retrieve("cus_1")
        assert [r for r in caplog.records if r.name == "invoice_ai"] == []

    def test_honours_invoice_ai_log_debug(
        self, router: respx.MockRouter, caplog: pytest.LogCaptureFixture, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("INVOICE_AI_LOG", "debug")
        FakeServer(router, json_response(200, {"data": customer("cus_1")}))
        with caplog.at_level(logging.DEBUG, logger="invoice_ai"):
            InvoiceAI(api_key=API_KEY, base_url="https://api.test").customers.retrieve("cus_1")
        assert any("→ GET /customers/cus_1" in r.getMessage() for r in caplog.records)

    def test_redaction_helpers(self) -> None:
        assert redact_api_key(API_KEY) == "inv_live_ab12cd34…"
        assert redact_api_key("whatever-secret") == "what…"
        assert redact_secrets(f"key={API_KEY} secret=whsec_abc+/=") == "key=inv_live_ab12cd34… secret=whsec_…"
        assert redact_headers({"Authorization": f"Bearer {API_KEY}", "Cookie": "a=b", "Idempotency-Key": "k"}) == {
            "authorization": "Bearer inv_live_ab12cd34…",
            "cookie": "[redacted]",
            "idempotency-key": "k",
        }
