"""Retries, idempotency, timeouts and request shape. Mirrors packages/sdk-ts/test/http.test.ts."""

from __future__ import annotations

import asyncio
import re
from email.utils import formatdate

import httpx
import pytest
import respx
from helpers import FakeServer, async_client, client, created, customer, json_response, ok, problem

import invoice_ai._retry as retry_mod
from invoice_ai import (
    APIConnectionError,
    APITimeoutError,
    ConflictError,
    InternalServerError,
    InvalidStateError,
    NotFoundError,
    RateLimitError,
    UpstreamError,
    ValidationError,
)
from invoice_ai._retry import RetryContext, compute_backoff, server_requested_delay, should_retry

UUID4 = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")


def reset() -> httpx.ReadError:
    """A connection reset after the request was sent."""
    return httpx.ReadError("[Errno 54] Connection reset by peer (ECONNRESET)")


def refused() -> httpx.ConnectError:
    """A connection refused before anything was sent."""
    return httpx.ConnectError("[Errno 61] Connection refused (ECONNREFUSED)")


class TestRetries:
    def test_retries_a_429_after_retry_after_not_the_shorter_backoff(self, router: respx.MockRouter) -> None:
        server = FakeServer(router, problem(429, "rate_limited", headers={"retry-after": "0.25"}), ok())
        assert client().customers.retrieve("cus_1").id == "cus_1"
        assert len(server.calls) == 2
        assert 0.24 <= server.gap() < 1.5

    def test_falls_back_to_ratelimit_reset_as_a_unix_timestamp(
        self, router: respx.MockRouter, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Freeze time 0.7s into a second; the window resets on the next second → wait 300ms.
        class FrozenTime:
            @staticmethod
            def time() -> float:
                return 1_789_371_000.7

        monkeypatch.setattr(retry_mod, "time", FrozenTime)
        server = FakeServer(router, problem(429, "rate_limited", headers={"ratelimit-reset": "1789371001"}), ok())
        client().customers.retrieve("cus_1")
        assert len(server.calls) == 2
        assert 0.29 <= server.gap() < 1.5

    def test_gives_up_on_a_429_whose_retry_after_exceeds_max_retry_after(self, router: respx.MockRouter) -> None:
        server = FakeServer(router, problem(429, "rate_limited", headers={"retry-after": "3600"}), ok())
        with pytest.raises(RateLimitError) as exc:
            client().customers.retrieve("cus_1")
        assert exc.value.retry_after == 3600
        assert len(server.calls) == 1

    def test_retries_503_and_500_then_succeeds(self, router: respx.MockRouter) -> None:
        server = FakeServer(router, problem(503, "upstream_failed"), problem(500, "internal_error"), ok())
        assert client().customers.retrieve("cus_1").id == "cus_1"
        assert len(server.calls) == 3

    def test_throws_the_last_error_after_max_retries(self, router: respx.MockRouter) -> None:
        server = FakeServer(router, problem(500, "internal_error"))
        with pytest.raises(InternalServerError):
            client(max_retries=3).customers.list()
        assert len(server.calls) == 4

    def test_honours_a_per_request_max_retries(self, router: respx.MockRouter) -> None:
        server = FakeServer(router, problem(502, "upstream_failed"))
        with pytest.raises(UpstreamError):
            client().customers.retrieve("cus_1", max_retries=0)
        assert len(server.calls) == 1

    def test_retries_network_errors(self, router: respx.MockRouter) -> None:
        server = FakeServer(router, reset(), reset(), ok())
        assert client().customers.retrieve("cus_1").id == "cus_1"
        assert len(server.calls) == 3

    def test_surfaces_a_network_error_as_api_connection_error_once_retries_run_out(
        self, router: respx.MockRouter
    ) -> None:
        server = FakeServer(router, reset())
        with pytest.raises(APIConnectionError) as exc:
            client().customers.retrieve("cus_1")
        assert "ECONNRESET" in str(exc.value)
        assert isinstance(exc.value.__cause__, httpx.ReadError)
        assert len(server.calls) == 3

    def test_retries_409_conflict_but_not_invalid_state(self, router: respx.MockRouter) -> None:
        a = FakeServer(router, problem(409, "conflict"), created())
        client().customers.create(name="Acme")
        assert len(a.calls) == 2

    def test_does_not_retry_409_invalid_state(self, router: respx.MockRouter) -> None:
        b = FakeServer(router, problem(409, "invalid_state"))
        with pytest.raises(InvalidStateError):
            client().invoices.finalize("in_1")
        assert len(b.calls) == 1

    @pytest.mark.parametrize(
        ("status", "code", "cls"),
        [(400, "validation", ValidationError), (404, "not_found", NotFoundError), (422, "validation", ValidationError)],
    )
    def test_does_not_retry_client_errors(self, router: respx.MockRouter, status: int, code: str, cls: type) -> None:
        server = FakeServer(router, problem(status, code))
        with pytest.raises(cls):
            client().customers.retrieve("cus_1")
        assert len(server.calls) == 1


class TestIdempotency:
    def test_sends_a_generated_uuid_key_on_post_and_reuses_it_on_every_retry(self, router: respx.MockRouter) -> None:
        server = FakeServer(router, problem(503, "upstream_failed"), reset(), created())
        raw = client().customers.with_raw_response.create(name="Acme")
        assert len(server.calls) == 3
        keys = [c.headers.get("idempotency-key") for c in server.calls]
        assert UUID4.match(keys[0] or "")
        assert len(set(keys)) == 1
        assert raw.idempotency_key == keys[0]
        assert raw.attempts == 3
        assert raw.parse().id == "cus_1"

    def test_uses_a_fresh_key_for_each_separate_call(self, router: respx.MockRouter) -> None:
        server = FakeServer(router, created())
        c = client()
        c.customers.create(name="A")
        c.customers.create(name="B")
        assert server.calls[0].headers["idempotency-key"] != server.calls[1].headers["idempotency-key"]

    def test_uses_the_caller_supplied_key_across_retries(self, router: respx.MockRouter) -> None:
        server = FakeServer(router, problem(500, "internal_error"), json_response(200, {"data": {"id": "in_1"}}))
        client().invoices.finalize("in_1", idempotency_key="finalize-in_1-v1")
        assert [c.headers.get("idempotency-key") for c in server.calls] == ["finalize-in_1-v1", "finalize-in_1-v1"]

    def test_does_not_send_a_key_on_get_patch_or_delete(self, router: respx.MockRouter) -> None:
        server = FakeServer(router, ok())
        c = client()
        c.customers.retrieve("cus_1")
        c.customers.update("cus_1", name="X")
        c.customers.delete("cus_1")
        assert [x.headers.get("idempotency-key") for x in server.calls] == [None, None, None]

    def test_exposes_idempotent_replayed_on_the_response(self, router: respx.MockRouter) -> None:
        FakeServer(router, json_response(201, {"data": customer("cus_1")}, {"idempotent-replayed": "true"}))
        raw = client().customers.with_raw_response.create(name="Acme")
        assert raw.idempotent_replayed is True

    def test_rejects_an_overlong_key(self, router: respx.MockRouter) -> None:
        FakeServer(router, created())
        with pytest.raises(ValueError):
            client().customers.create(name="A", idempotency_key="k" * 256)


class TestNonIdempotentWrites:
    def test_does_not_retry_a_patch_after_a_503(self, router: respx.MockRouter) -> None:
        server = FakeServer(router, problem(503, "upstream_failed"), ok())
        with pytest.raises(UpstreamError):
            client().customers.update("cus_1", name="X")
        assert len(server.calls) == 1

    def test_does_not_retry_a_delete_after_a_connection_reset(self, router: respx.MockRouter) -> None:
        server = FakeServer(router, reset(), ok())
        with pytest.raises(APIConnectionError):
            client().customers.delete("cus_1")
        assert len(server.calls) == 1

    def test_retries_a_patch_when_the_connection_was_refused_before_sending(self, router: respx.MockRouter) -> None:
        server = FakeServer(router, refused(), ok())
        client().customers.update("cus_1", name="X")
        assert len(server.calls) == 2

    def test_retries_a_patch_after_a_connect_timeout(self, router: respx.MockRouter) -> None:
        server = FakeServer(router, httpx.ConnectTimeout("connect timed out"), ok())
        client().customers.update("cus_1", name="X")
        assert len(server.calls) == 2

    def test_retries_a_delete_on_429(self, router: respx.MockRouter) -> None:
        server = FakeServer(router, problem(429, "rate_limited", headers={"retry-after": "0"}), ok())
        client().customers.delete("cus_1")
        assert len(server.calls) == 2


class TestTimeouts:
    def test_times_out_with_api_timeout_error_and_retries_gets(self, router: respx.MockRouter) -> None:
        server = FakeServer(router, httpx.ReadTimeout("timed out"), httpx.ReadTimeout("timed out"), ok())
        assert client(timeout=0.02).customers.retrieve("cus_1").id == "cus_1"
        assert len(server.calls) == 3

    def test_raises_api_timeout_error_when_every_attempt_times_out(self, router: respx.MockRouter) -> None:
        server = FakeServer(router, httpx.ReadTimeout("timed out"))
        with pytest.raises(APITimeoutError) as exc:
            client(max_retries=1).customers.retrieve("cus_1", timeout=0.01)
        assert isinstance(exc.value, APIConnectionError)
        assert "0.01s" in str(exc.value)
        assert len(server.calls) == 2

    def test_does_not_retry_a_timed_out_patch(self, router: respx.MockRouter) -> None:
        server = FakeServer(router, httpx.ReadTimeout("timed out"))
        with pytest.raises(APITimeoutError):
            client(timeout=0.01).customers.update("cus_1", name="X")
        assert len(server.calls) == 1

    def test_passes_the_timeout_to_httpx_per_attempt(self, router: respx.MockRouter) -> None:
        server = FakeServer(router, ok())
        client(timeout=12).customers.retrieve("cus_1", timeout=3.5)
        assert server.calls[0].request.extensions["timeout"]["read"] == 3.5

    async def test_async_cancellation_stops_without_retrying(self, router: respx.MockRouter) -> None:
        async def hang(_req: httpx.Request) -> httpx.Response:
            await asyncio.sleep(10)
            return ok()

        server = FakeServer(router, hang)
        task = asyncio.ensure_future(async_client().customers.retrieve("cus_1"))
        await asyncio.sleep(0.05)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert len(server.calls) == 1


class TestRequestShape:
    def test_sends_auth_version_user_agent_and_json(self, router: respx.MockRouter) -> None:
        server = FakeServer(router, created())
        client().customers.create(name="Acme", email="ap@acme.example")
        req = server.calls[0]
        assert req.method == "POST"
        assert str(req.url) == "https://api.test/api/v1/customers"
        assert req.headers["authorization"].startswith("Bearer inv_live_")
        assert req.headers["invoice-ai-version"] == "1.0.0"
        assert re.match(r"^invoice-ai-python/\d+\.\d+\.\d+ \(python \d+\.\d+; \w+\)$", req.headers["user-agent"])
        assert req.headers["content-type"] == "application/json"
        assert req.body == {"name": "Acme", "email": "ap@acme.example"}

    def test_serialises_query_params_and_path_params(self, router: respx.MockRouter) -> None:
        server = FakeServer(router, json_response(200, {"data": [], "next_cursor": None}))
        client().invoices.list(status="open", limit=10)
        client().invoice_items.delete("ii_1/x", invoice="in_9")
        assert server.calls[0].url.query == b"limit=10&status=open"  # spec order
        assert server.calls[1].url.raw_path.startswith(b"/api/v1/invoice-items/ii_1%2Fx?")
        assert server.calls[1].url.params["invoice"] == "in_9"

    def test_keyword_params_map_to_wire_names_and_types(self, router: respx.MockRouter) -> None:
        import datetime

        server = FakeServer(router, json_response(200, {"data": [], "next_cursor": None}))
        client().invoices.list(from_=datetime.date(2026, 9, 1), to="2026-09-30")
        client().customers.list(include_deleted=True)
        assert server.calls[0].url.query == b"from=2026-09-01&to=2026-09-30"
        assert server.calls[1].url.query == b"include_deleted=true"

    def test_none_is_sent_as_null_and_omitted_params_are_not_sent(self, router: respx.MockRouter) -> None:
        server = FakeServer(router, ok())
        client().products.update("prod_1", description=None)
        assert server.calls[0].body == {"description": None}

    def test_returns_rate_limit_info_and_the_request_id_via_with_raw_response(self, router: respx.MockRouter) -> None:
        FakeServer(
            router,
            json_response(
                200,
                {"data": customer("cus_1")},
                {"ratelimit-limit": "120", "ratelimit-remaining": "119", "ratelimit-reset": "1789371294"},
            ),
        )
        raw = client().customers.with_raw_response.retrieve("cus_1")
        assert raw.parse().id == "cus_1"
        assert raw.request_id == "req_test123"
        assert raw.status_code == 200
        assert raw.headers["x-request-id"] == "req_test123"
        assert (raw.rate_limit.limit, raw.rate_limit.remaining, raw.rate_limit.reset) == (120, 119, 1789371294)

    def test_returns_bytes_for_the_pdf_and_none_for_204s(self, router: respx.MockRouter) -> None:
        pdf = httpx.Response(200, headers={"content-type": "application/pdf"}, content=bytes([37, 80, 68, 70]))
        server = FakeServer(router, pdf, json_response(204, None))
        c = client()
        assert c.invoices.pdf("in_1") == b"%PDF"
        assert server.calls[0].headers["accept"] == "application/pdf, application/problem+json"
        assert c.invoices.delete("in_1") is None


class TestPureHelpers:
    def test_should_retry_encodes_the_method_status_matrix(self) -> None:
        assert should_retry(RetryContext(method="GET", status=500)) is True
        assert should_retry(RetryContext(method="POST", status=502)) is True
        assert should_retry(RetryContext(method="PATCH", status=502)) is False
        assert should_retry(RetryContext(method="DELETE", status=429)) is True
        assert should_retry(RetryContext(method="GET", status=408)) is True
        assert should_retry(RetryContext(method="POST", status=409, code="conflict")) is True
        assert should_retry(RetryContext(method="POST", status=409, code="invalid_state")) is False
        assert should_retry(RetryContext(method="GET", status=404)) is False
        assert should_retry(RetryContext(method="PATCH", failure="connection", pre_send=True)) is True
        assert should_retry(RetryContext(method="PATCH", failure="connection", pre_send=False)) is False
        assert should_retry(RetryContext(method="PATCH", failure="timeout")) is False

    def test_compute_backoff_doubles_from_half_a_second_caps_at_8s_and_jitters_down_by_at_most_25pct(self) -> None:
        assert [compute_backoff(n, 0.5, 8.0, lambda: 0) for n in range(6)] == [0.5, 1, 2, 4, 8, 8]
        assert compute_backoff(0, 0.5, 8.0, lambda: 1) == 0.375

    def test_server_requested_delay_reads_retry_after_seconds_dates_and_ratelimit_reset(self) -> None:
        now = 1_789_371_000.0
        assert server_requested_delay({"retry-after": "3"}, now) == 3
        assert server_requested_delay({"retry-after": formatdate(now + 5, usegmt=True)}, now) == 5
        assert server_requested_delay({"ratelimit-reset": "1789371010"}, now) == 10
        assert server_requested_delay({"ratelimit-reset": "7"}, now) == 7
        assert server_requested_delay({}, now) is None

    def test_maps_conflict_error_for_409_conflict(self, router: respx.MockRouter) -> None:
        FakeServer(router, problem(409, "conflict"))
        with pytest.raises(ConflictError):
            client(max_retries=0).customers.create(name="A")


class TestAsyncParity:
    """The async client shares the engine; spot-check the same rules through it."""

    async def test_retries_and_reuses_the_idempotency_key(self, router: respx.MockRouter) -> None:
        server = FakeServer(router, problem(503, "upstream_failed"), reset(), created())
        raw = await async_client().customers.with_raw_response.create(name="Acme")
        keys = {c.headers.get("idempotency-key") for c in server.calls}
        assert len(server.calls) == 3 and len(keys) == 1
        assert raw.attempts == 3
        assert raw.parse().id == "cus_1"

    async def test_does_not_retry_a_patch_after_a_503(self, router: respx.MockRouter) -> None:
        server = FakeServer(router, problem(503, "upstream_failed"), ok())
        with pytest.raises(UpstreamError):
            await async_client().customers.update("cus_1", name="X")
        assert len(server.calls) == 1

    async def test_honours_retry_after(self, router: respx.MockRouter) -> None:
        server = FakeServer(router, problem(429, "rate_limited", headers={"retry-after": "0.2"}), ok())
        assert (await async_client().customers.retrieve("cus_1")).id == "cus_1"
        assert 0.19 <= server.gap() < 1.5

    async def test_times_out_and_raises(self, router: respx.MockRouter) -> None:
        server = FakeServer(router, httpx.ReadTimeout("timed out"))
        with pytest.raises(APITimeoutError):
            await async_client(max_retries=1).customers.retrieve("cus_1")
        assert len(server.calls) == 2

    async def test_bytes_and_none(self, router: respx.MockRouter) -> None:
        pdf = httpx.Response(200, headers={"content-type": "application/pdf"}, content=b"%PDF")
        FakeServer(router, pdf, json_response(204, None))
        c = async_client()
        assert await c.invoices.pdf("in_1") == b"%PDF"
        assert await c.invoices.delete("in_1") is None
