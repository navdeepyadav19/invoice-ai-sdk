"""
horizonpay-invoice-ai — the official Python SDK for the Invoice-AI API.

    from invoice_ai import InvoiceAI

    client = InvoiceAI()                       # reads INVOICE_AI_API_KEY
    invoice = client.invoices.create(customer="cus_…", items=[{"price": "price_…", "quantity": 1}])
"""

from . import errors, types
from ._base_client import DEFAULT_BASE_URL
from ._client import AsyncInvoiceAI, InvoiceAI
from ._logging import LogLevel
from ._meta import API_VERSION
from ._operations import OPERATIONS, Operation
from ._response import APIResponse, ResponseMeta
from ._retry import RateLimitInfo
from ._types import NOT_GIVEN, NotGiven
from ._version import __version__
from .errors import (
    ERROR_CLASS_BY_CODE,
    APIConnectionError,
    APIError,
    APITimeoutError,
    AuthenticationError,
    ConflictError,
    FieldError,
    IdempotencyError,
    IdempotencyKeyRequiredError,
    InternalServerError,
    InvalidStateError,
    InvoiceAIError,
    NotFoundError,
    PermissionDeniedError,
    RateLimitError,
    UpstreamError,
    ValidationError,
    WebhookVerificationError,
)
from .errors import PermissionError as PermissionError  # parity with the TypeScript SDK
from .money import currency_decimals, format_money, from_minor, to_minor
from .pagination import AsyncPage, AsyncPagePromise, SyncPage
from .webhooks import (
    Webhook,
    WebhookEvent,
    WebhookEventType,
    Webhooks,
    construct_event,
    sign_payload,
    verify_signature,
)

VERSION = __version__

__all__ = [
    "API_VERSION",
    "DEFAULT_BASE_URL",
    "ERROR_CLASS_BY_CODE",
    "NOT_GIVEN",
    "OPERATIONS",
    "VERSION",
    "APIConnectionError",
    "APIError",
    "APIResponse",
    "APITimeoutError",
    "AsyncInvoiceAI",
    "AsyncPage",
    "AsyncPagePromise",
    "AuthenticationError",
    "ConflictError",
    "FieldError",
    "IdempotencyError",
    "IdempotencyKeyRequiredError",
    "InternalServerError",
    "InvalidStateError",
    "InvoiceAI",
    "InvoiceAIError",
    "LogLevel",
    "NotFoundError",
    "NotGiven",
    "Operation",
    "PermissionDeniedError",
    "RateLimitError",
    "RateLimitInfo",
    "ResponseMeta",
    "SyncPage",
    "UpstreamError",
    "ValidationError",
    "Webhook",
    "WebhookEvent",
    "WebhookEventType",
    "WebhookVerificationError",
    "Webhooks",
    "__version__",
    "construct_event",
    "currency_decimals",
    "errors",
    "format_money",
    "from_minor",
    "sign_payload",
    "to_minor",
    "types",
    "verify_signature",
]
