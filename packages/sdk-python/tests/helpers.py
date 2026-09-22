"""Shared fixtures-as-functions, mirroring packages/sdk-ts/test/helpers.ts."""

from __future__ import annotations

import asyncio
import json
import time
from typing import Any, Callable, Dict, List, Optional, Union

import httpx
import respx

from invoice_ai import AsyncInvoiceAI, InvoiceAI

API_KEY = "inv_live_ab12cd34_7Kf9QmXz2pR4vNt6LwYb8HsJ3dGc5eAu"
BASE = "https://api.test/api/v1"

Step = Union[httpx.Response, Exception, Callable[[httpx.Request], Any]]


class Recorded:
    """One request the fake server received."""

    def __init__(self, request: httpx.Request) -> None:
        self.request = request
        self.url = request.url
        self.method = request.method
        self.headers = request.headers
        raw = request.content
        self.body: Any = json.loads(raw) if raw else None
        self.at = time.monotonic()


class FakeServer:
    """
    Plays back ``steps`` in order (the last one repeats) and records every
    request, like fakeFetch() in the TS tests.
    """

    def __init__(self, router: respx.MockRouter, *steps: Step) -> None:
        self.steps = list(steps)
        self.calls: List[Recorded] = []
        router.route(host="api.test").mock(side_effect=self._handle)

    def _pick(self, request: httpx.Request) -> Any:
        self.calls.append(Recorded(request))
        return self.steps[min(len(self.calls) - 1, len(self.steps) - 1)]

    def _handle(self, request: httpx.Request) -> Any:
        step = self._pick(request)
        if callable(step) and not isinstance(step, (httpx.Response, Exception)):
            step = step(request)
        if asyncio.iscoroutine(step):
            return self._await(step)
        if isinstance(step, Exception):
            raise step
        return _copy(step)

    async def _await(self, coro: Any) -> httpx.Response:
        out = await coro
        if isinstance(out, Exception):
            raise out
        return _copy(out)

    def gap(self) -> float:
        return self.calls[1].at - self.calls[0].at


def _copy(res: httpx.Response) -> httpx.Response:
    return httpx.Response(res.status_code, headers=res.headers, content=res.content)


def json_response(status: int, body: Any, headers: Optional[Dict[str, str]] = None) -> httpx.Response:
    content = b"" if status == 204 else json.dumps(body).encode()
    return httpx.Response(
        status,
        headers={"content-type": "application/json", "x-request-id": "req_test123", **(headers or {})},
        content=content,
    )


def problem(
    status: int,
    code: str,
    extra: Optional[Dict[str, Any]] = None,
    headers: Optional[Dict[str, str]] = None,
) -> httpx.Response:
    body = {
        "type": f"https://invoice.horizonpay.co/problems/{code.replace('_', '-')}",
        "title": code,
        "status": status,
        "detail": f"detail for {code}",
        "instance": "req_problem",
        "code": code,
        **(extra or {}),
    }
    return httpx.Response(
        status,
        headers={"content-type": "application/problem+json", "x-request-id": "req_err42", **(headers or {})},
        content=json.dumps(body).encode(),
    )


def client(**options: Any) -> InvoiceAI:
    kwargs: Dict[str, Any] = {
        "api_key": API_KEY,
        "base_url": BASE,
        "initial_retry_delay": 0.001,
        "max_retry_delay": 0.004,
        "log_level": "off",
    }
    kwargs.update(options)
    return InvoiceAI(**kwargs)


def async_client(**options: Any) -> AsyncInvoiceAI:
    kwargs: Dict[str, Any] = {
        "api_key": API_KEY,
        "base_url": BASE,
        "initial_retry_delay": 0.001,
        "max_retry_delay": 0.004,
        "log_level": "off",
    }
    kwargs.update(options)
    return AsyncInvoiceAI(**kwargs)


def customer(id: str) -> Dict[str, Any]:
    return {
        "id": id,
        "object": "customer",
        "name": f"Customer {id}",
        "email": None,
        "phone": None,
        "tax_id": None,
        "address": None,
        "deleted": False,
        "created": "2026-09-22T09:30:00.000Z",
    }


def ok() -> httpx.Response:
    return json_response(200, {"data": customer("cus_1")})


def created() -> httpx.Response:
    return json_response(201, {"data": customer("cus_1")})
