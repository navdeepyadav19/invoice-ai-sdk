"""``InvoiceAI`` and ``AsyncInvoiceAI``: the clients you construct."""

from __future__ import annotations

from typing import Mapping, Optional

import httpx

from ._logging import LogLevel
from .resources import AsyncInvoiceAIResources, InvoiceAIResources
from .webhooks import Webhooks

__all__ = ["AsyncInvoiceAI", "InvoiceAI"]


class InvoiceAI(InvoiceAIResources):
    """
    The Invoice-AI API client.

        client = InvoiceAI()                      # reads INVOICE_AI_API_KEY
        customer = client.customers.create(name="Acme", email="ap@acme.com")

    Args:
        api_key: Defaults to the ``INVOICE_AI_API_KEY`` environment variable.
        base_url: Defaults to ``INVOICE_AI_BASE_URL``, then the production API.
        timeout: Seconds per attempt. Default 60.
        max_retries: Automatic retries per call. Default 2.
        default_headers: Headers added to every request.
        http_client: Your own ``httpx.Client`` (proxies, custom transports, tests).
        log_level: ``"debug"`` logs every request and retry decision (secrets
            redacted). Default ``"warn"``, or ``INVOICE_AI_LOG``.
        webhook_secret: Default secret for ``client.webhooks``.
        initial_retry_delay: First retry delay in seconds. Default 0.5.
        max_retry_delay: Backoff cap in seconds. Default 8.
        max_retry_after: Longest ``Retry-After`` waited through automatically, in seconds. Default 60.
    """

    #: Webhook signature verification: ``client.webhooks.construct_event(body, headers, secret)``.
    webhooks: Webhooks

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
        webhook_secret: Optional[str] = None,
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
            http_client=http_client,
            log_level=log_level,
            initial_retry_delay=initial_retry_delay,
            max_retry_delay=max_retry_delay,
            max_retry_after=max_retry_after,
        )
        self.webhooks = Webhooks(webhook_secret)


class AsyncInvoiceAI(AsyncInvoiceAIResources):
    """
    The asyncio Invoice-AI API client. Same options as ``InvoiceAI``;
    ``http_client`` is an ``httpx.AsyncClient``.

        async with AsyncInvoiceAI() as client:
            invoice = await client.invoices.retrieve("in_…")
            async for inv in client.invoices.list(status="open"):
                ...
    """

    #: Webhook signature verification (synchronous: it does no I/O).
    webhooks: Webhooks

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
        webhook_secret: Optional[str] = None,
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
            http_client=http_client,
            log_level=log_level,
            initial_retry_delay=initial_retry_delay,
            max_retry_delay=max_retry_delay,
            max_retry_after=max_retry_after,
        )
        self.webhooks = Webhooks(webhook_secret)
