"""
Errors you can branch on.

    try:
        client.invoices.void(invoice_id, reason="Duplicate")
    except invoice_ai.InvalidStateError:
        ...

Every API error keeps the server's RFC 9457 problem fields (``code``,
``detail``, ``type``, ``status``), the request id and the raw body. The message
always ends with "(request req_…)" so a pasted traceback is enough for support
to find the request.
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Mapping, Optional, Type

import httpx
from typing_extensions import TypedDict

__all__ = [
    "ERROR_CLASS_BY_CODE",
    "APIConnectionError",
    "APIError",
    "APITimeoutError",
    "AuthenticationError",
    "ConflictError",
    "FieldError",
    "IdempotencyError",
    "IdempotencyKeyRequiredError",
    "InternalServerError",
    "InvalidStateError",
    "InvoiceAIError",
    "NotFoundError",
    "PermissionDeniedError",
    "RateLimitError",
    "UpstreamError",
    "ValidationError",
    "WebhookVerificationError",
    "make_api_error",
]


class FieldError(TypedDict):
    """One field-level problem from a 422."""

    path: str
    message: str


class InvoiceAIError(Exception):
    """Base class of everything this SDK raises."""

    @property
    def message(self) -> str:
        return str(self.args[0]) if self.args else ""


class APIError(InvoiceAIError):
    """Any non-2xx response from the API."""

    #: HTTP status, e.g. 409.
    status: int
    #: Stable machine-readable code, e.g. ``invalid_state``. Branch on this.
    code: Optional[str]
    #: Human-readable explanation. Wording may change; don't parse it.
    detail: Optional[str]
    #: Problem type URL.
    type: Optional[str]
    title: Optional[str]
    #: ``X-Request-Id`` (or the problem's ``instance``). Quote it to support.
    request_id: Optional[str]
    #: Field-level problems (422). Empty when there are none.
    fields: List[FieldError]
    headers: httpx.Headers
    #: The parsed response body, untouched.
    body: Any

    def __init__(
        self,
        *,
        status: int,
        body: Any,
        headers: Optional[httpx.Headers] = None,
        required_scope: Optional[str] = None,
    ) -> None:
        hdrs = headers if headers is not None else httpx.Headers()
        problem = _as_problem(body)
        instance = problem.get("instance")
        request_id = hdrs.get("x-request-id") or (instance if isinstance(instance, str) else None)
        super().__init__(_format_message(status, problem, request_id))
        self.status = status
        self.code = _str_or_none(problem.get("code"))
        self.detail = _str_or_none(problem.get("detail"))
        self.type = _str_or_none(problem.get("type"))
        self.title = _str_or_none(problem.get("title"))
        self.request_id = request_id
        errors = problem.get("errors")
        self.fields = list(errors) if isinstance(errors, list) else []
        self.headers = hdrs
        self.body = body

    @property
    def status_code(self) -> int:
        """Alias of ``status``."""
        return self.status


class AuthenticationError(APIError):
    """401 ``unauthorized``: missing, malformed, unknown, revoked or expired key."""


class PermissionDeniedError(APIError):
    """
    403 ``forbidden``: the key is valid but lacks the scope this operation needs.

    Named ``PermissionError`` in the TypeScript SDK; Python already has a
    built-in of that name, so it is also importable as
    ``invoice_ai.errors.PermissionError`` but not exported with ``*``.
    """

    #: The scope that was missing, when known (e.g. ``invoices:write``).
    required_scope: Optional[str]

    def __init__(
        self,
        *,
        status: int,
        body: Any,
        headers: Optional[httpx.Headers] = None,
        required_scope: Optional[str] = None,
    ) -> None:
        super().__init__(status=status, body=body, headers=headers, required_scope=required_scope)
        self.required_scope = _scope_from_detail(self.detail) or required_scope


PermissionError = PermissionDeniedError  # parity with the TypeScript SDK


class NotFoundError(APIError):
    """404 ``not_found``: no such resource, or it belongs to another account."""


class InvalidStateError(APIError):
    """409 ``invalid_state``: the resource is in the wrong state; retrying won't help."""


class ConflictError(APIError):
    """409 ``conflict``: clashed with a concurrent request; retrying later may work."""


class ValidationError(APIError):
    """422 ``validation``: see ``.fields`` for each field that failed."""


class IdempotencyError(APIError):
    """422 ``idempotency_mismatch``: an ``Idempotency-Key`` was reused with a different request."""


class IdempotencyKeyRequiredError(IdempotencyError):
    """428 ``idempotency_key_required``: the endpoint needs an ``Idempotency-Key``."""


class RateLimitError(APIError):
    """429 ``rate_limited``."""

    #: Seconds the server asked us to wait (``Retry-After``), if sent.
    retry_after: Optional[float]

    def __init__(
        self,
        *,
        status: int,
        body: Any,
        headers: Optional[httpx.Headers] = None,
        required_scope: Optional[str] = None,
    ) -> None:
        super().__init__(status=status, body=body, headers=headers, required_scope=required_scope)
        raw = self.headers.get("retry-after")
        self.retry_after = _finite_float(raw)


class InternalServerError(APIError):
    """500 ``internal_error``."""


class UpstreamError(APIError):
    """502 ``upstream_failed``: a provider we depend on (email, database) failed."""


class APIConnectionError(InvoiceAIError):
    """The request never produced an HTTP response (DNS, TLS, reset, offline…)."""

    def __init__(self, message: str = "Connection error.") -> None:
        super().__init__(message)


class APITimeoutError(APIConnectionError):
    """The request took longer than ``timeout``."""

    def __init__(self, message: str = "Request timed out.") -> None:
        super().__init__(message)


class WebhookVerificationError(InvoiceAIError):
    """A webhook failed signature, timestamp or payload checks."""


#: Server ``code`` → class. Every code the API documents has an entry.
ERROR_CLASS_BY_CODE: Mapping[str, Type[APIError]] = {
    "unauthorized": AuthenticationError,
    "forbidden": PermissionDeniedError,
    "not_found": NotFoundError,
    "invalid_state": InvalidStateError,
    "conflict": ConflictError,
    "validation": ValidationError,
    "idempotency_mismatch": IdempotencyError,
    "idempotency_key_required": IdempotencyKeyRequiredError,
    "rate_limited": RateLimitError,
    "internal_error": InternalServerError,
    "upstream_failed": UpstreamError,
}


def _class_for_status(status: int) -> Type[APIError]:
    """Fallback when the body has no known ``code`` (e.g. a proxy's HTML 502)."""
    if status == 401:
        return AuthenticationError
    if status == 403:
        return PermissionDeniedError
    if status == 404:
        return NotFoundError
    if status == 422:
        return ValidationError
    if status == 428:
        return IdempotencyKeyRequiredError
    if status == 429:
        return RateLimitError
    if status in (502, 503, 504):
        return UpstreamError
    if status >= 500:
        return InternalServerError
    return APIError


def make_api_error(
    *,
    status: int,
    body: Any,
    headers: Optional[httpx.Headers] = None,
    required_scope: Optional[str] = None,
) -> APIError:
    """Builds the most specific error for a response."""
    code = _as_problem(body).get("code")
    cls = (ERROR_CLASS_BY_CODE.get(code) if isinstance(code, str) else None) or _class_for_status(status)
    return cls(status=status, body=body, headers=headers, required_scope=required_scope)


def _as_problem(body: Any) -> Dict[str, Any]:
    return body if isinstance(body, dict) else {}


def _str_or_none(value: Any) -> Optional[str]:
    return value if isinstance(value, str) else None


def _finite_float(raw: Optional[str]) -> Optional[float]:
    if raw is None or raw.strip() == "":
        return None
    try:
        n = float(raw)
    except ValueError:
        return None
    return n if n == n and n not in (float("inf"), float("-inf")) else None


def _format_message(status: int, problem: Mapping[str, Any], request_id: Optional[str]) -> str:
    code = _str_or_none(problem.get("code"))
    code = code if code is not None else f"http_{status}"
    detail, title = _str_or_none(problem.get("detail")), _str_or_none(problem.get("title"))
    text = detail if detail is not None else title if title is not None else f"Request failed with status {status}"
    errors = problem.get("errors")
    if isinstance(errors, list) and errors:
        parts = []
        for e in errors[:5]:
            item = e if isinstance(e, dict) else {}
            parts.append(f"{item.get('path') or '(body)'}: {item.get('message')}")
        text += f" [{'; '.join(parts)}{'; …' if len(errors) > 5 else ''}]"
    return f"{status} {code}: {text}{f' (request {request_id})' if request_id else ''}"


_SCOPE_RE = re.compile(r"\b([a-z_]+:[a-z_]+)\b")


def _scope_from_detail(detail: Optional[str]) -> Optional[str]:
    if not detail:
        return None
    m = _SCOPE_RE.search(detail)
    return m.group(1) if m else None
