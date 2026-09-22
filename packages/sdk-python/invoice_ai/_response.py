"""
Response metadata and raw responses.

    invoice = client.invoices.retrieve(invoice_id)                       # the parsed model
    raw = client.invoices.with_raw_response.retrieve(invoice_id)          # everything else too
    raw.request_id; raw.rate_limit.remaining; raw.headers["x-request-id"]
    invoice = raw.parse()
"""

from __future__ import annotations

import contextvars
import functools
from typing import Any, Awaitable, Callable, Generic, Optional, TypeVar, cast

import httpx
from typing_extensions import ParamSpec

from ._retry import RateLimitInfo, parse_rate_limit

T = TypeVar("T")
P = ParamSpec("P")


class ResponseMeta:
    """Everything about the HTTP response besides the parsed data."""

    def __init__(
        self, http_response: httpx.Response, *, url: str, idempotency_key: Optional[str], attempts: int
    ) -> None:
        #: The underlying ``httpx.Response`` (its body has already been read).
        self.http_response = http_response
        self.status_code: int = http_response.status_code
        self.headers: httpx.Headers = http_response.headers
        self.url = url
        #: ``X-Request-Id``. Quote it to support.
        self.request_id: Optional[str] = http_response.headers.get("x-request-id")
        #: True when the server replayed a stored response for this Idempotency-Key.
        self.idempotent_replayed: bool = http_response.headers.get("idempotent-replayed") == "true"
        #: The Idempotency-Key that was sent, if any.
        self.idempotency_key = idempotency_key
        self.rate_limit: RateLimitInfo = parse_rate_limit(http_response.headers)
        #: How many attempts it took (1 = no retries).
        self.attempts = attempts

    def __repr__(self) -> str:
        return f"<{type(self).__name__} {self.status_code} request_id={self.request_id!r}>"


class APIResponse(ResponseMeta, Generic[T]):
    """A response whose data hasn't been handed over yet: call ``.parse()``."""

    def __init__(
        self,
        http_response: httpx.Response,
        *,
        url: str,
        idempotency_key: Optional[str],
        attempts: int,
        parser: Callable[[], T],
    ) -> None:
        super().__init__(http_response, url=url, idempotency_key=idempotency_key, attempts=attempts)
        self._parser = parser
        self._parsed: Any = _UNSET

    def parse(self) -> T:
        """The same value the non-raw method returns (a model, a page, bytes or None)."""
        if self._parsed is _UNSET:
            self._parsed = self._parser()
        return cast(T, self._parsed)


_UNSET: Any = object()

# Set while a `.with_raw_response` wrapper is calling the method underneath.
_RAW_RESPONSE: contextvars.ContextVar[bool] = contextvars.ContextVar("invoice_ai_raw_response", default=False)


def want_raw_response() -> bool:
    return _RAW_RESPONSE.get()


def to_raw_response_wrapper(func: Callable[P, T]) -> Callable[P, APIResponse[T]]:
    """Turns ``resource.method`` into one that returns an ``APIResponse``."""

    @functools.wraps(func)
    def wrapped(*args: P.args, **kwargs: P.kwargs) -> APIResponse[T]:
        token = _RAW_RESPONSE.set(True)
        try:
            return cast(APIResponse[T], func(*args, **kwargs))
        finally:
            _RAW_RESPONSE.reset(token)

    return wrapped


def async_to_raw_response_wrapper(func: Callable[P, Awaitable[T]]) -> Callable[P, Awaitable[APIResponse[T]]]:
    """Async version of ``to_raw_response_wrapper``."""

    @functools.wraps(func)
    async def wrapped(*args: P.args, **kwargs: P.kwargs) -> APIResponse[T]:
        token = _RAW_RESPONSE.set(True)
        try:
            return cast(APIResponse[T], await func(*args, **kwargs))
        finally:
            _RAW_RESPONSE.reset(token)

    return wrapped
