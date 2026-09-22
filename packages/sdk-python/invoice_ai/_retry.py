"""
Retry policy, as pure functions so it's easy to test.

Retries (up to ``max_retries``, default 2) happen on:
  - network errors and timeouts,
  - 408, 409 ``conflict`` (an idempotent request is still in flight),
  - 429 (waiting for ``Retry-After`` / ``RateLimit-Reset``),
  - any 5xx.
Backoff is exponential with jitter, 0.5s doubling to an 8s cap.

Which methods may be retried:
  - GET/HEAD: always safe.
  - POST: always carries an Idempotency-Key that is reused on every retry,
    so the server replays instead of repeating the work.
  - PATCH/DELETE: no idempotency key on this API, so after the request may
    have reached the server we never resend it. They are retried only when
    the connection failed before anything was sent (DNS, refused), or on
    429, which the API returns before running the handler.
"""

from __future__ import annotations

import random as _random
import time
from dataclasses import dataclass
from email.utils import parsedate_to_datetime
from typing import Any, Callable, List, Mapping, Optional, Tuple
from urllib.parse import quote, urlencode

from typing_extensions import Literal

SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})


@dataclass(frozen=True)
class RetryContext:
    method: str
    status: Optional[int] = None
    code: Optional[str] = None
    #: For failures without a response.
    failure: Optional[Literal["timeout", "connection"]] = None
    #: The connection failed before any bytes were sent.
    pre_send: bool = False


def should_retry(ctx: RetryContext) -> bool:
    """Whether one failed attempt may be retried."""
    method = ctx.method.upper()
    replay_safe = method in SAFE_METHODS or method == "POST"
    if ctx.failure == "connection":
        return replay_safe or ctx.pre_send
    if ctx.failure == "timeout":
        return replay_safe
    status = ctx.status or 0
    if status == 429:
        return True
    if not replay_safe:
        return False
    if status == 408:
        return True
    if status == 409:
        return ctx.code == "conflict"
    return status >= 500


def compute_backoff(
    retry_index: int,
    initial: float = 0.5,
    maximum: float = 8.0,
    random: Callable[[], float] = _random.random,
) -> float:
    """Exponential backoff with jitter, in seconds: base·2^n capped, minus up to 25%."""
    base: float = min(initial * 2**retry_index, maximum)
    return base * (1 - 0.25 * random())


def server_requested_delay(headers: Mapping[str, str], now: Optional[float] = None) -> Optional[float]:
    """
    How long the server asked us to wait, in seconds, or None.

    ``Retry-After`` is seconds or an HTTP date. This API's ``RateLimit-Reset`` is
    a Unix timestamp; values that look like deltas (< 1e9) are treated as seconds.
    """
    current = time.time() if now is None else now
    retry_after = _header(headers, "retry-after")
    if retry_after is not None and retry_after.strip() != "":
        secs = _finite(retry_after)
        if secs is not None:
            return max(0.0, secs)
        try:
            when = parsedate_to_datetime(retry_after)
        except (TypeError, ValueError, IndexError):
            when = None
        if when is not None:
            return max(0.0, when.timestamp() - current)
    reset = _header(headers, "ratelimit-reset")
    if reset is not None and reset.strip() != "":
        n = _finite(reset)
        if n is not None:
            return max(0.0, n - current if n > 1e9 else n)
    return None


@dataclass(frozen=True)
class RateLimitInfo:
    limit: Optional[int]
    remaining: Optional[int]
    #: Unix seconds at which the window resets.
    reset: Optional[int]


def parse_rate_limit(headers: Mapping[str, str]) -> RateLimitInfo:
    def num(name: str) -> Optional[int]:
        n = _finite(_header(headers, name))
        return None if n is None else int(n)

    return RateLimitInfo(
        limit=num("ratelimit-limit"), remaining=num("ratelimit-remaining"), reset=num("ratelimit-reset")
    )


def _query_value(v: Any) -> str:
    if isinstance(v, bool):
        return "true" if v else "false"
    iso = getattr(v, "isoformat", None)
    if callable(iso):
        return str(iso())
    return str(v)


def build_url(base_url: str, path: str, query: Optional[Mapping[str, Any]] = None) -> str:
    """Base URL + path + query. ``None`` values are skipped; lists repeat the key."""
    url = base_url.rstrip("/") + (path if path.startswith("/") else f"/{path}")
    pairs: List[Tuple[str, str]] = []
    for key, value in (query or {}).items():
        if value is None:
            continue
        values = value if isinstance(value, (list, tuple)) else [value]
        pairs.extend((key, _query_value(v)) for v in values)
    return f"{url}?{urlencode(pairs)}" if pairs else url


def path_param(name: str, value: Any) -> str:
    """Encodes one path parameter, refusing empty values (``/customers/None``)."""
    if not isinstance(value, str) or value == "":
        got = "an empty string" if value == "" else type(value).__name__
        from .errors import InvoiceAIError

        raise InvoiceAIError(f"`{name}` must be a non-empty string, got {got}")
    # Same set as JavaScript's encodeURIComponent.
    return quote(value, safe="!*'()")


def _header(headers: Mapping[str, str], name: str) -> Optional[str]:
    getter = getattr(headers, "get", None)
    value = getter(name) if callable(getter) else None
    if value is None:
        for k, v in headers.items():
            if k.lower() == name:
                return v
    return value if value is None or isinstance(value, str) else str(value)


def _finite(value: Optional[str]) -> Optional[float]:
    if value is None:
        return None
    try:
        n = float(value)
    except ValueError:
        return None
    if n != n or n in (float("inf"), float("-inf")):
        return None
    return n
