"""Small shared types: the NOT_GIVEN sentinel and per-request options."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping, Optional

from typing_extensions import Literal, final

HttpMethod = Literal["GET", "POST", "PATCH", "PUT", "DELETE", "HEAD"]


@final
class NotGiven:
    """
    Marks a keyword argument the caller didn't pass, as distinct from ``None``
    (which is sent as JSON ``null``, e.g. to clear a field).
    """

    _instance: Optional[NotGiven] = None

    def __new__(cls) -> NotGiven:
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance

    def __bool__(self) -> Literal[False]:
        return False

    def __repr__(self) -> str:
        return "NOT_GIVEN"


NOT_GIVEN = NotGiven()


@dataclass
class RequestSpec:
    """One SDK call, as the generated resources describe it to the client."""

    method: HttpMethod
    #: Path under the base URL, e.g. ``/invoices/in_123/finalize``.
    path: str
    query: Optional[Mapping[str, Any]] = None
    body: Any = None
    #: Your own Idempotency-Key. Otherwise POSTs get a generated UUID.
    idempotency_key: Optional[str] = None
    #: Seconds per attempt before giving up. Default: the client's (60).
    timeout: Optional[float] = None
    #: Automatic retries for this call. Default: the client's (2).
    max_retries: Optional[int] = None
    #: Extra headers for this call.
    extra_headers: Optional[Mapping[str, str]] = None
    #: Media type(s) of a binary response, e.g. ``application/pdf``.
    accept: Optional[str] = None
    #: The spec's ``x-required-scope``, attached to 403 errors.
    required_scope: Optional[str] = None
    #: ``bytes`` for binary downloads, else JSON.
    binary: bool = False
