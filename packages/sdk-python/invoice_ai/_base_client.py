"""
The HTTP engine shared by ``InvoiceAI`` and ``AsyncInvoiceAI``: one SDK call →
one or more attempts, with retries, idempotency, error mapping and logging.
The retry policy itself lives in ``_retry.py``.
"""

from __future__ import annotations

import asyncio
import json
import platform
import re
import sys
import time
from dataclasses import dataclass
from typing import Any, Dict, Mapping, Optional, Tuple, Type, TypeVar, Union
from urllib.parse import urlsplit

import httpx
from typing_extensions import Literal

from ._logging import LogLevel, SDKLogger, read_env, redact_api_key, redact_headers
from ._meta import API_VERSION
from ._response import APIResponse, ResponseMeta, want_raw_response
from ._retry import RetryContext, build_url, compute_backoff, server_requested_delay, should_retry
from ._types import HttpMethod, RequestSpec
from ._utils import IDEMPOTENCY_HEADER, dumps, resolve_idempotency_key, validate_model
from ._version import __version__
from .errors import APIConnectionError, APITimeoutError, InvoiceAIError, make_api_error
from .pagination import AsyncPage, AsyncPagePromise, SyncPage

T = TypeVar("T")

DEFAULT_BASE_URL = "https://invoice.horizonpay.co/api/v1"
DEFAULT_TIMEOUT = 60.0
DEFAULT_MAX_RETRIES = 2

_KEY_RE = re.compile(r"^inv_[a-z]+_\S+$")

Kind = Literal["data", "body"]


def user_agent() -> str:
    """``invoice-ai-python/0.1.0 (python 3.12; darwin)``."""
    python = f"{sys.version_info[0]}.{sys.version_info[1]}"
    return f"invoice-ai-python/{__version__} (python {python}; {platform.system().lower() or 'unknown'})"


@dataclass
class _Prepared:
    method: str
    url: str
    path_for_log: str
    headers: httpx.Headers
    content: Optional[bytes]
    idempotency_key: Optional[str]
    timeout: float
    max_retries: int
    required_scope: Optional[str]


@dataclass
class _Result:
    response: httpx.Response
    body: Any
    prepared: _Prepared
    attempts: int

    def meta(self) -> ResponseMeta:
        return ResponseMeta(
            self.response, url=self.prepared.url, idempotency_key=self.prepared.idempotency_key, attempts=self.attempts
        )


def _classify(exc: httpx.TransportError) -> Tuple[Literal["timeout", "connection"], bool]:
    """(failure, pre_send). Connecting (or waiting for a pooled connection) means nothing was sent."""
    if isinstance(exc, (httpx.ConnectTimeout, httpx.PoolTimeout)):
        return "connection", True
    if isinstance(exc, httpx.TimeoutException):
        return "timeout", False
    if isinstance(exc, httpx.ConnectError):
        return "connection", True
    return "connection", False


def _read_body(response: httpx.Response, binary: bool) -> Any:
    if response.status_code in (204, 205) or response.headers.get("content-length") == "0":
        return None
    if binary and response.is_success:
        return response.content
    text = response.text
    if text == "":
        return None
    if "json" in response.headers.get("content-type", ""):
        try:
            return json.loads(text)
        except ValueError:
            return text
    return text


class BaseClient:
    """Configuration and the parts of the request loop that don't do I/O."""

    base_url: str
    timeout: float
    max_retries: int

    def __init__(
        self,
        *,
        api_key: Optional[str],
        base_url: Optional[str],
        timeout: Optional[float],
        max_retries: Optional[int],
        default_headers: Optional[Mapping[str, str]],
        log_level: Optional[LogLevel],
        initial_retry_delay: float,
        max_retry_delay: float,
        max_retry_after: float,
    ) -> None:
        key = api_key if api_key is not None else read_env("INVOICE_AI_API_KEY")
        if not key:
            raise InvoiceAIError(
                "Missing API key. Pass `InvoiceAI(api_key=...)` or set INVOICE_AI_API_KEY. "
                "Create one under Settings → API keys."
            )
        if not _KEY_RE.match(key):
            raise InvoiceAIError("That does not look like an Invoice-AI API key: keys start with `inv_live_`.")
        self._api_key = key
        self.base_url = base_url or read_env("INVOICE_AI_BASE_URL") or DEFAULT_BASE_URL
        self.timeout = DEFAULT_TIMEOUT if timeout is None else timeout
        self.max_retries = DEFAULT_MAX_RETRIES if max_retries is None else max_retries
        self.default_headers: Dict[str, str] = dict(default_headers or {})
        self.initial_retry_delay = initial_retry_delay
        self.max_retry_delay = max_retry_delay
        self.max_retry_after = max_retry_after
        self._logger = SDKLogger(log_level)

    @property
    def api_key(self) -> str:
        return self._api_key

    def __repr__(self) -> str:
        return f"<{type(self).__name__} base_url={self.base_url!r} api_key={redact_api_key(self._api_key)!r}>"

    # --- request building -------------------------------------------------

    def _prepare(self, spec: RequestSpec) -> _Prepared:
        method = spec.method.upper()
        url = build_url(self.base_url, spec.path, spec.query)
        # Chosen once, before the first attempt: every retry reuses it.
        idempotency_key = resolve_idempotency_key(method, spec.idempotency_key)
        headers = httpx.Headers(
            {
                # Errors are always application/problem+json, so binary endpoints accept both.
                "Accept": f"{spec.accept}, application/problem+json" if spec.accept else "application/json",
                "Authorization": f"Bearer {self._api_key}",
                "Invoice-AI-Version": API_VERSION,
                "User-Agent": user_agent(),
            }
        )
        for k, v in self.default_headers.items():
            headers[k] = v
        if idempotency_key:
            headers[IDEMPOTENCY_HEADER] = idempotency_key
        content: Optional[bytes] = None
        if spec.body is not None and method not in ("GET", "HEAD"):
            content = dumps(spec.body)
            headers["Content-Type"] = "application/json"
        for k, v in (spec.extra_headers or {}).items():
            headers[k] = v
        return _Prepared(
            method=method,
            url=url,
            path_for_log=urlsplit(url).path,
            headers=headers,
            content=content,
            idempotency_key=idempotency_key,
            timeout=self.timeout if spec.timeout is None else spec.timeout,
            max_retries=max(0, self.max_retries if spec.max_retries is None else spec.max_retries),
            required_scope=spec.required_scope,
        )

    def _log_attempt(self, p: _Prepared, attempt: int) -> None:
        if self._logger.is_debug():
            retry = f" (retry {attempt})" if attempt else ""
            headers = json.dumps(redact_headers(p.headers), ensure_ascii=False)
            self._logger.debug(f"→ {p.method} {p.path_for_log}{retry} {headers}")

    def _transport_decision(
        self, exc: httpx.TransportError, p: _Prepared, attempt: int
    ) -> Tuple[APIConnectionError, Optional[float]]:
        """The error to raise, and the delay before retrying (None: don't retry)."""
        failure, pre_send = _classify(exc)
        timed_out = isinstance(exc, httpx.TimeoutException)
        error: APIConnectionError = (
            APITimeoutError(f"Request timed out after {p.timeout}s ({p.method} {p.path_for_log}).")
            if timed_out
            else APIConnectionError(f"Connection error ({p.method} {p.path_for_log}): {_describe(exc)}")
        )
        if attempt < p.max_retries and should_retry(RetryContext(method=p.method, failure=failure, pre_send=pre_send)):
            delay = compute_backoff(attempt, self.initial_retry_delay, self.max_retry_delay)
            kind = "timeout" if timed_out else failure
            self._logger.debug(f"retrying {p.method} {p.path_for_log} in {_ms(delay)}ms after {kind} error")
            return error, delay
        return error, None

    def _status_decision(self, response: httpx.Response, body: Any, p: _Prepared, attempt: int) -> Optional[float]:
        """Delay before retrying a failed response, or None to raise it."""
        code = body.get("code") if isinstance(body, dict) else None
        code = code if isinstance(code, str) else None
        status = response.status_code
        if attempt < p.max_retries and should_retry(RetryContext(method=p.method, status=status, code=code)):
            requested = server_requested_delay(response.headers) if status in (429, 503) else None
            if requested is None or requested <= self.max_retry_after:
                delay = (
                    requested
                    if requested is not None
                    else compute_backoff(attempt, self.initial_retry_delay, self.max_retry_delay)
                )
                self._logger.debug(
                    f"retrying {p.method} {p.path_for_log} in {_ms(delay)}ms "
                    f"(attempt {attempt + 2} of {p.max_retries + 1}) after {status}{f' {code}' if code else ''}"
                )
                return delay
            self._logger.debug(f"not retrying: server asked to wait {_ms(requested)}ms, over max_retry_after")
        return None

    def _log_response(self, response: httpx.Response, p: _Prepared, started: float) -> None:
        if self._logger.is_debug():
            rid = response.headers.get("x-request-id") or "no request id"
            elapsed = _ms(time.monotonic() - started)
            self._logger.debug(f"← {response.status_code} {p.method} {p.path_for_log} ({rid}, {elapsed}ms)")

    def _raise_for(self, response: httpx.Response, body: Any, p: _Prepared) -> None:
        raise make_api_error(
            status=response.status_code, body=body, headers=response.headers, required_scope=p.required_scope
        )

    # --- parsing ------------------------------------------------------------

    @staticmethod
    def _unwrap(kind: Kind, body: Any) -> Any:
        if kind == "data" and isinstance(body, dict) and "data" in body:
            return body["data"]
        return body


def _ms(seconds: float) -> int:
    return round(seconds * 1000)


def _describe(exc: BaseException) -> str:
    text = str(exc) or type(exc).__name__
    cause = exc.__cause__ or exc.__context__
    if cause is not None and str(cause) and str(cause) not in text:
        text = f"{text} ({cause})"
    return f"{type(exc).__name__}: {text}"


def _spec_with_cursor(spec: RequestSpec, cursor: str) -> RequestSpec:
    query = dict(spec.query or {})
    query.pop("cursor", None)
    query["cursor"] = cursor
    return RequestSpec(
        method=spec.method,
        path=spec.path,
        query=query,
        body=spec.body,
        # Later pages are GETs: no idempotency key to carry over.
        idempotency_key=None,
        timeout=spec.timeout,
        max_retries=spec.max_retries,
        extra_headers=spec.extra_headers,
        accept=spec.accept,
        required_scope=spec.required_scope,
    )


class SyncAPIClient(BaseClient):
    """The synchronous transport every resource shares."""

    def __init__(
        self,
        *,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        timeout: Optional[float] = None,
        max_retries: Optional[int] = None,
        default_headers: Optional[Mapping[str, str]] = None,
        http_client: Optional[httpx.Client] = None,
        log_level: Optional[LogLevel] = None,
        initial_retry_delay: float = 0.5,
        max_retry_delay: float = 8.0,
        max_retry_after: float = 60.0,
    ) -> None:
        super().__init__(
            api_key=api_key,
            base_url=base_url,
            timeout=timeout,
            max_retries=max_retries,
            default_headers=default_headers,
            log_level=log_level,
            initial_retry_delay=initial_retry_delay,
            max_retry_delay=max_retry_delay,
            max_retry_after=max_retry_after,
        )
        self._owns_http_client = http_client is None
        self._http = http_client if http_client is not None else httpx.Client()

    def close(self) -> None:
        """Closes the underlying HTTP client (unless you passed your own)."""
        if self._owns_http_client:
            self._http.close()

    def __enter__(self: T) -> T:
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

    def _execute(self, spec: RequestSpec) -> _Result:
        p = self._prepare(spec)
        attempt = 0
        while True:
            started = time.monotonic()
            self._log_attempt(p, attempt)
            try:
                response = self._http.request(
                    p.method, p.url, headers=p.headers, content=p.content, timeout=httpx.Timeout(p.timeout)
                )
                body = _read_body(response, spec.binary)
            except httpx.TransportError as exc:
                error, delay = self._transport_decision(exc, p, attempt)
                if delay is None:
                    raise error from exc
                time.sleep(delay)
                attempt += 1
                continue
            self._log_response(response, p, started)
            if response.is_success:
                return _Result(response, body, p, attempt + 1)
            delay = self._status_decision(response, body, p, attempt)
            if delay is None:
                self._raise_for(response, body, p)
            time.sleep(delay or 0)
            attempt += 1

    def _respond(self, result: _Result, parse: Any) -> Any:
        if want_raw_response():
            return APIResponse(
                result.response,
                url=result.prepared.url,
                idempotency_key=result.prepared.idempotency_key,
                attempts=result.attempts,
                parser=parse,
            )
        return parse()

    # --- used by generated resources ----------------------------------------

    def _request(self, spec: RequestSpec, cast_to: Type[T], kind: Kind) -> T:
        result = self._execute(spec)
        return self._respond(result, lambda: validate_model(cast_to, self._unwrap(kind, result.body)))  # type: ignore[no-any-return]

    def _request_none(self, spec: RequestSpec) -> None:
        result = self._execute(spec)
        return self._respond(result, lambda: None)  # type: ignore[no-any-return]

    def _request_bytes(self, spec: RequestSpec) -> bytes:
        result = self._execute(RequestSpec(**{**spec.__dict__, "binary": True}))
        return self._respond(result, lambda: result.body if isinstance(result.body, bytes) else b"")  # type: ignore[no-any-return]

    def _request_page(self, spec: RequestSpec, item: Type[T]) -> SyncPage[T]:
        raw = want_raw_response()
        result = self._execute(spec)
        page = self._page(spec, item, result)
        if raw:
            return self._respond(result, lambda: page)  # type: ignore[no-any-return]
        return page

    def _page(self, spec: RequestSpec, item: Type[T], result: _Result) -> SyncPage[T]:
        def fetch_next(cursor: str) -> SyncPage[T]:
            next_spec = _spec_with_cursor(spec, cursor)
            return self._page(next_spec, item, self._execute(next_spec))

        return SyncPage(result.body, result.meta(), lambda d: validate_model(item, d), fetch_next)

    # --- escape hatch ---------------------------------------------------------

    def request(
        self,
        method: Union[HttpMethod, str],
        path: str,
        *,
        query: Optional[Mapping[str, Any]] = None,
        body: Any = None,
        idempotency_key: Optional[str] = None,
        timeout: Optional[float] = None,
        max_retries: Optional[int] = None,
        extra_headers: Optional[Mapping[str, str]] = None,
    ) -> Any:
        """
        Escape hatch for endpoints the SDK doesn't wrap yet. Returns the parsed
        response body as-is (not unwrapped from ``data``), with the same
        retries, idempotency, errors and logging as every other call.

            body = client.request("GET", "/business")
        """
        spec = RequestSpec(
            method=method.upper(),  # type: ignore[arg-type]
            path=path,
            query=query,
            body=body,
            idempotency_key=idempotency_key,
            timeout=timeout,
            max_retries=max_retries,
            extra_headers=extra_headers,
        )
        result = self._execute(spec)
        return self._respond(result, lambda: result.body)


class AsyncAPIClient(BaseClient):
    """The asyncio transport every resource shares."""

    def __init__(
        self,
        *,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        timeout: Optional[float] = None,
        max_retries: Optional[int] = None,
        default_headers: Optional[Mapping[str, str]] = None,
        http_client: Optional[httpx.AsyncClient] = None,
        log_level: Optional[LogLevel] = None,
        initial_retry_delay: float = 0.5,
        max_retry_delay: float = 8.0,
        max_retry_after: float = 60.0,
    ) -> None:
        super().__init__(
            api_key=api_key,
            base_url=base_url,
            timeout=timeout,
            max_retries=max_retries,
            default_headers=default_headers,
            log_level=log_level,
            initial_retry_delay=initial_retry_delay,
            max_retry_delay=max_retry_delay,
            max_retry_after=max_retry_after,
        )
        self._owns_http_client = http_client is None
        self._http = http_client if http_client is not None else httpx.AsyncClient()

    async def close(self) -> None:
        """Closes the underlying HTTP client (unless you passed your own)."""
        if self._owns_http_client:
            await self._http.aclose()

    async def __aenter__(self: T) -> T:
        return self

    async def __aexit__(self, *_exc: object) -> None:
        await self.close()

    async def _execute(self, spec: RequestSpec) -> _Result:
        p = self._prepare(spec)
        attempt = 0
        while True:
            started = time.monotonic()
            self._log_attempt(p, attempt)
            try:
                response = await self._http.request(
                    p.method, p.url, headers=p.headers, content=p.content, timeout=httpx.Timeout(p.timeout)
                )
                body = _read_body(response, spec.binary)
            except httpx.TransportError as exc:
                error, delay = self._transport_decision(exc, p, attempt)
                if delay is None:
                    raise error from exc
                await asyncio.sleep(delay)
                attempt += 1
                continue
            self._log_response(response, p, started)
            if response.is_success:
                return _Result(response, body, p, attempt + 1)
            delay = self._status_decision(response, body, p, attempt)
            if delay is None:
                self._raise_for(response, body, p)
            await asyncio.sleep(delay or 0)
            attempt += 1

    def _respond(self, raw: bool, result: _Result, parse: Any) -> Any:
        if raw:
            return APIResponse(
                result.response,
                url=result.prepared.url,
                idempotency_key=result.prepared.idempotency_key,
                attempts=result.attempts,
                parser=parse,
            )
        return parse()

    # --- used by generated resources ----------------------------------------

    async def _request(self, spec: RequestSpec, cast_to: Type[T], kind: Kind) -> T:
        raw = want_raw_response()
        result = await self._execute(spec)
        return self._respond(raw, result, lambda: validate_model(cast_to, self._unwrap(kind, result.body)))  # type: ignore[no-any-return]

    async def _request_none(self, spec: RequestSpec) -> None:
        raw = want_raw_response()
        result = await self._execute(spec)
        return self._respond(raw, result, lambda: None)  # type: ignore[no-any-return]

    async def _request_bytes(self, spec: RequestSpec) -> bytes:
        raw = want_raw_response()
        result = await self._execute(RequestSpec(**{**spec.__dict__, "binary": True}))
        return self._respond(raw, result, lambda: result.body if isinstance(result.body, bytes) else b"")  # type: ignore[no-any-return]

    def _request_page(self, spec: RequestSpec, item: Type[T]) -> AsyncPagePromise[T]:
        async def load() -> Any:
            raw = want_raw_response()
            result = await self._execute(spec)
            page = self._page(spec, item, result)
            return self._respond(raw, result, lambda: page) if raw else page

        return AsyncPagePromise(load)

    def _page(self, spec: RequestSpec, item: Type[T], result: _Result) -> AsyncPage[T]:
        async def fetch_next(cursor: str) -> AsyncPage[T]:
            next_spec = _spec_with_cursor(spec, cursor)
            return self._page(next_spec, item, await self._execute(next_spec))

        return AsyncPage(result.body, result.meta(), lambda d: validate_model(item, d), fetch_next)

    # --- escape hatch ---------------------------------------------------------

    async def request(
        self,
        method: Union[HttpMethod, str],
        path: str,
        *,
        query: Optional[Mapping[str, Any]] = None,
        body: Any = None,
        idempotency_key: Optional[str] = None,
        timeout: Optional[float] = None,
        max_retries: Optional[int] = None,
        extra_headers: Optional[Mapping[str, str]] = None,
    ) -> Any:
        """
        Escape hatch for endpoints the SDK doesn't wrap yet. Returns the parsed
        response body as-is (not unwrapped from ``data``), with the same
        retries, idempotency, errors and logging as every other call.

            body = await client.request("GET", "/business")
        """
        raw = want_raw_response()
        spec = RequestSpec(
            method=method.upper(),  # type: ignore[arg-type]
            path=path,
            query=query,
            body=body,
            idempotency_key=idempotency_key,
            timeout=timeout,
            max_retries=max_retries,
            extra_headers=extra_headers,
        )
        result = await self._execute(spec)
        return self._respond(raw, result, lambda: result.body)
