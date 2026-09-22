"""
Standard Webhooks verification (https://www.standardwebhooks.com).

    event = client.webhooks.construct_event(raw_body, request.headers, secret)
    if event.type == "invoice.paid":
        fulfil(event.data.object)

Or without a client (no API key needed):

    event = Webhook("whsec_…").verify(raw_body, request.headers)

Checks, in order:
  1. ``webhook-id``, ``webhook-timestamp`` and ``webhook-signature`` are present;
  2. the timestamp is within ±``tolerance`` seconds (default 300) of now;
  3. HMAC-SHA256 over ``{id}.{timestamp}.{raw body}`` with the secret's bytes
     matches one of the space-separated ``v1,<base64>`` signatures (several
     appear while a secret is being rotated), compared in constant time.

Secrets look like ``whsec_<base64>``; older endpoints were issued base64url
secrets, and both decode correctly here.

Verify the RAW body (``await request.body()``, ``request.get_data()``). A body
that was JSON-parsed and re-serialised won't match.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
import re
import secrets
import time
from typing import Any, Dict, Iterable, Mapping, Optional, Tuple, Union

import pydantic
from typing_extensions import Literal, get_args

from ._utils import validate_model
from .errors import WebhookVerificationError
from .types import Invoice

__all__ = [
    "DEFAULT_TOLERANCE_SECONDS",
    "Webhook",
    "WebhookEvent",
    "WebhookEventData",
    "WebhookEventType",
    "Webhooks",
    "construct_event",
    "sign_payload",
    "verify_signature",
]

#: Every event type the API emits.
WebhookEventType = Literal[
    "invoice.created",
    "invoice.updated",
    "invoice.finalized",
    "invoice.emailed",
    "invoice.email_failed",
    "invoice.viewed",
    "invoice.downloaded",
    "invoice.paid",
    "invoice.voided",
]
WEBHOOK_EVENT_TYPES: Tuple[str, ...] = get_args(WebhookEventType)

DEFAULT_TOLERANCE_SECONDS = 300

#: Headers as a dict, ``httpx.Headers``, a Starlette/Django/Flask headers object or a list of pairs.
WebhookHeaders = Union[Mapping[str, Any], Iterable[Tuple[str, Any]], Any]
WebhookPayload = Union[str, bytes, bytearray, memoryview]


class WebhookEventData(pydantic.BaseModel):
    model_config = pydantic.ConfigDict(extra="allow")

    #: The invoice as of the event.
    object: Invoice


class WebhookEvent(pydantic.BaseModel):
    """A verified webhook delivery."""

    model_config = pydantic.ConfigDict(extra="allow")

    #: Event id; the same on every endpoint and every retry. Deduplicate on it.
    id: str
    type: WebhookEventType
    #: ISO 8601 time the event happened.
    created_at: str
    data: WebhookEventData


def _header(headers: WebhookHeaders, name: str) -> Optional[str]:
    items: Iterable[Tuple[str, Any]]
    if hasattr(headers, "items"):
        items = headers.items()
    elif isinstance(headers, (list, tuple)):
        items = headers
    else:
        getter = getattr(headers, "get", None)
        value = getter(name) if callable(getter) else None
        return None if value is None else str(value)
    for key, value in items:
        if str(key).lower() == name:
            if isinstance(value, (list, tuple)):
                return " ".join(str(v) for v in value)
            return None if value is None else str(value)
    return None


def _to_bytes(payload: WebhookPayload) -> bytes:
    if isinstance(payload, str):
        return payload.encode("utf-8")
    if isinstance(payload, (bytes, bytearray, memoryview)):
        return bytes(payload)
    raise WebhookVerificationError(
        "The webhook payload must be the raw body (str or bytes), not a parsed object."
    )


_B64_RE = re.compile(r"^[A-Za-z0-9+/]*$")


def decode_base64(value: str) -> bytes:
    """Decodes standard base64 or base64url, with or without padding."""
    normalized = value.strip().replace("-", "+").replace("_", "/").rstrip("=")
    if not _B64_RE.match(normalized) or len(normalized) % 4 == 1:
        raise WebhookVerificationError("Invalid base64")
    padded = normalized + "=" * ((4 - len(normalized) % 4) % 4)
    try:
        return base64.b64decode(padded, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise WebhookVerificationError("Invalid base64") from exc


def secret_key_bytes(secret: str) -> bytes:
    """The key bytes of a ``whsec_…`` secret (base64 or base64url)."""
    if not isinstance(secret, str) or secret.strip() == "":
        raise WebhookVerificationError("Missing webhook signing secret.")
    raw = secret.strip()
    if raw.startswith("whsec_"):
        raw = raw[len("whsec_") :]
    try:
        key = decode_base64(raw)
    except WebhookVerificationError:
        key = b""
    if not key:
        raise WebhookVerificationError(
            "The webhook secret is not valid base64. Copy it exactly as issued (whsec_…)."
        )
    return key


def _compute_signature(secret: str, msg_id: str, timestamp: str, payload: bytes) -> bytes:
    return hmac.new(secret_key_bytes(secret), f"{msg_id}.{timestamp}.".encode() + payload, hashlib.sha256).digest()


def verify_signature(
    payload: WebhookPayload,
    headers: WebhookHeaders,
    secret: str,
    *,
    tolerance: int = DEFAULT_TOLERANCE_SECONDS,
    now: Optional[int] = None,
) -> None:
    """Checks a delivery's signature and timestamp. Raises ``WebhookVerificationError`` if invalid."""
    msg_id = _header(headers, "webhook-id")
    timestamp = _header(headers, "webhook-timestamp")
    signature_header = _header(headers, "webhook-signature")
    if not msg_id or not timestamp or not signature_header:
        raise WebhookVerificationError("Missing webhook-id, webhook-timestamp or webhook-signature header.")

    ts_text = timestamp.strip()
    if not re.fullmatch(r"\d+", ts_text) or int(ts_text) > 2**53 - 1:
        raise WebhookVerificationError("Invalid webhook-timestamp header.")
    ts = int(ts_text)
    current = int(time.time()) if now is None else now
    if current - ts > tolerance:
        raise WebhookVerificationError("Webhook timestamp is too old.")
    if ts - current > tolerance:
        raise WebhookVerificationError("Webhook timestamp is too far in the future.")

    mac = _compute_signature(secret, msg_id, ts_text, _to_bytes(payload))
    expected = f"v1,{base64.b64encode(mac).decode()}".encode()
    matched = False
    for part in signature_header.split(" "):
        if not part.startswith("v1,"):
            continue  # other schemes (v1a…) aren't ours
        # Compare the exact encoded string, as the reference implementations do.
        # Don't short-circuit: check every signature so timing doesn't reveal which matched.
        if hmac.compare_digest(part.encode(), expected):
            matched = True
    if not matched:
        raise WebhookVerificationError("No matching webhook signature found.")


def construct_event(
    payload: WebhookPayload,
    headers: WebhookHeaders,
    secret: str,
    *,
    tolerance: int = DEFAULT_TOLERANCE_SECONDS,
    now: Optional[int] = None,
) -> WebhookEvent:
    """
    Verifies a delivery and returns its parsed, typed event.
    Raises ``WebhookVerificationError`` if the signature, timestamp or JSON is bad.
    """
    verify_signature(payload, headers, secret, tolerance=tolerance, now=now)
    try:
        event = json.loads(_to_bytes(payload).decode("utf-8"))
    except (ValueError, UnicodeDecodeError) as exc:
        raise WebhookVerificationError("Webhook body is not valid JSON.") from exc
    if not isinstance(event, dict) or not isinstance(event.get("type"), str):
        raise WebhookVerificationError("Webhook body is not an event object.")
    return validate_model(WebhookEvent, event)


def sign_payload(
    payload: WebhookPayload,
    secret: str,
    *,
    msg_id: Optional[str] = None,
    timestamp: Optional[int] = None,
) -> Dict[str, str]:
    """
    Signs a payload the way Invoice-AI does, returning the three headers.
    Useful for testing your handler locally.
    """
    mid = msg_id if msg_id is not None else f"msg_{secrets.token_hex(12)}"
    ts = str(timestamp if timestamp is not None else int(time.time()))
    sig = _compute_signature(secret, mid, ts, _to_bytes(payload))
    return {
        "webhook-id": mid,
        "webhook-timestamp": ts,
        "webhook-signature": f"v1,{base64.b64encode(sig).decode()}",
    }


class Webhooks:
    """``client.webhooks``. ``secret`` defaults to the one given to the constructor."""

    def __init__(self, secret: Optional[str] = None) -> None:
        self._default_secret = secret

    def construct_event(
        self,
        payload: WebhookPayload,
        headers: WebhookHeaders,
        secret: Optional[str] = None,
        *,
        tolerance: int = DEFAULT_TOLERANCE_SECONDS,
        now: Optional[int] = None,
    ) -> WebhookEvent:
        """Verifies and parses a delivery."""
        return construct_event(payload, headers, self._secret(secret), tolerance=tolerance, now=now)

    def verify_signature(
        self,
        payload: WebhookPayload,
        headers: WebhookHeaders,
        secret: Optional[str] = None,
        *,
        tolerance: int = DEFAULT_TOLERANCE_SECONDS,
        now: Optional[int] = None,
    ) -> None:
        """Verifies a delivery without parsing it."""
        verify_signature(payload, headers, self._secret(secret), tolerance=tolerance, now=now)

    def sign(
        self,
        payload: WebhookPayload,
        secret: Optional[str] = None,
        *,
        msg_id: Optional[str] = None,
        timestamp: Optional[int] = None,
    ) -> Dict[str, str]:
        """Produces signed headers for a payload (for local testing)."""
        return sign_payload(payload, self._secret(secret), msg_id=msg_id, timestamp=timestamp)

    def _secret(self, secret: Optional[str]) -> str:
        s = secret if secret is not None else self._default_secret
        if not s:
            raise WebhookVerificationError("Pass the endpoint signing secret (whsec_…).")
        return s


class Webhook(Webhooks):
    """
    A verifier bound to one endpoint secret.

        wh = Webhook("whsec_…")
        event = wh.verify(raw_body, headers)      # WebhookEvent, or raises WebhookVerificationError
        headers = wh.sign(raw_body)               # for tests
    """

    def __init__(self, secret: str) -> None:
        if not secret:
            raise WebhookVerificationError("Pass the endpoint signing secret (whsec_…).")
        secret_key_bytes(secret)  # fail fast on a malformed secret
        super().__init__(secret)

    def verify(
        self,
        payload: WebhookPayload,
        headers: WebhookHeaders,
        *,
        tolerance: int = DEFAULT_TOLERANCE_SECONDS,
        now: Optional[int] = None,
    ) -> WebhookEvent:
        """Verifies and parses a delivery (same as ``construct_event``)."""
        return self.construct_event(payload, headers, tolerance=tolerance, now=now)
