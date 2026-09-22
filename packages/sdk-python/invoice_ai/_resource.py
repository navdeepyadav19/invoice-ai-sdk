"""Base classes of the generated resources (``client.invoices``, ``client.customers``…)."""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from ._base_client import AsyncAPIClient, SyncAPIClient


class SyncAPIResource:
    def __init__(self, client: SyncAPIClient) -> None:
        self._client = client


class AsyncAPIResource:
    def __init__(self, client: AsyncAPIClient) -> None:
        self._client = client
