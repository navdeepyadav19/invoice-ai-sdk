"""Cursor pagination. Mirrors packages/sdk-ts/test/pagination.test.ts, for sync and async."""

from __future__ import annotations

from typing import List, Optional

import httpx
import respx
from helpers import FakeServer, async_client, client, customer, json_response

from invoice_ai import AsyncPage, SyncPage


def three_pages(router: respx.MockRouter) -> FakeServer:
    """Three pages: cus_1..3, cus_4..6, cus_7..8."""

    def handler(req: httpx.Request) -> httpx.Response:
        cursor = req.url.params.get("cursor")
        if not cursor:
            return json_response(200, {"data": [customer(i) for i in ("cus_1", "cus_2", "cus_3")], "next_cursor": "c2"})
        if cursor == "c2":
            return json_response(200, {"data": [customer(i) for i in ("cus_4", "cus_5", "cus_6")], "next_cursor": "c3"})
        if cursor == "c3":
            return json_response(200, {"data": [customer(i) for i in ("cus_7", "cus_8")], "next_cursor": None})
        return json_response(500, {})

    return FakeServer(router, handler)


ALL = ["cus_1", "cus_2", "cus_3", "cus_4", "cus_5", "cus_6", "cus_7", "cus_8"]


class TestSync:
    def test_list_gives_one_page(self, router: respx.MockRouter) -> None:
        server = three_pages(router)
        page = client().customers.list(limit=3)
        assert isinstance(page, SyncPage)
        assert [c.id for c in page.data] == ["cus_1", "cus_2", "cus_3"]
        assert page.next_cursor == "c2"
        assert page.has_more is True
        assert page.response.request_id == "req_test123"
        assert len(server.calls) == 1

    def test_iterating_list_walks_all_three_pages_keeping_the_filters(self, router: respx.MockRouter) -> None:
        server = three_pages(router)
        ids = [c.id for c in client().customers.list(limit=3, query="acme")]
        assert ids == ALL
        assert [c.url.query for c in server.calls] == [
            b"limit=3&query=acme",
            b"limit=3&query=acme&cursor=c2",
            b"limit=3&query=acme&cursor=c3",
        ]

    def test_a_fetched_page_is_itself_iterable_from_that_page_onwards(self, router: respx.MockRouter) -> None:
        three_pages(router)
        second = client().customers.list().get_next_page()
        assert second is not None
        assert [c.id for c in second] == ALL[3:]

    def test_iter_pages_yields_each_page_and_get_next_page_returns_none_at_the_end(
        self, router: respx.MockRouter
    ) -> None:
        three_pages(router)
        sizes: List[int] = []
        last: Optional[SyncPage[object]] = None
        for p in client().customers.list().iter_pages():
            sizes.append(len(p.data))
            last = p  # type: ignore[assignment]
        assert sizes == [3, 3, 2]
        assert last is not None and last.has_next_page() is False
        assert last.get_next_page() is None

    def test_to_list_with_limit_stops_fetching_once_it_has_enough(self, router: respx.MockRouter) -> None:
        server = three_pages(router)
        items = client().customers.list().to_list(limit=4)
        assert [c.id for c in items] == ALL[:4]
        assert len(server.calls) == 2

    def test_to_list_without_limit_collects_everything(self, router: respx.MockRouter) -> None:
        three_pages(router)
        assert len(client().customers.list().to_list()) == 8

    def test_treats_a_plain_array_response_as_a_single_page(self, router: respx.MockRouter) -> None:
        server = FakeServer(router, json_response(200, {"data": [{"id": "ii_1"}, {"id": "ii_2"}]}))
        items = client().invoice_items.list(invoice="in_1").to_list()
        assert len(items) == 2
        assert len(server.calls) == 1

    def test_later_pages_carry_no_idempotency_key(self, router: respx.MockRouter) -> None:
        server = three_pages(router)
        client().customers.list(idempotency_key="x").to_list()
        assert all(c.headers.get("idempotency-key") is None for c in server.calls[1:])

    def test_raw_response_parses_into_a_page(self, router: respx.MockRouter) -> None:
        three_pages(router)
        raw = client().customers.with_raw_response.list(limit=3)
        assert raw.request_id == "req_test123"
        page = raw.parse()
        assert isinstance(page, SyncPage)
        assert [c.id for c in page] == ALL


class TestAsync:
    async def test_awaiting_list_gives_one_page(self, router: respx.MockRouter) -> None:
        server = three_pages(router)
        page = await async_client().customers.list(limit=3)
        assert isinstance(page, AsyncPage)
        assert [c.id for c in page.data] == ["cus_1", "cus_2", "cus_3"]
        assert page.next_cursor == "c2"
        assert len(server.calls) == 1

    async def test_async_for_over_list_walks_every_page(self, router: respx.MockRouter) -> None:
        server = three_pages(router)
        ids = [c.id async for c in async_client().customers.list(limit=3, query="acme")]
        assert ids == ALL
        assert server.calls[2].url.query == b"limit=3&query=acme&cursor=c3"

    async def test_async_for_over_an_awaited_page(self, router: respx.MockRouter) -> None:
        three_pages(router)
        page = await async_client().customers.list()
        second = await page.get_next_page()
        assert second is not None
        assert [c.id async for c in second] == ALL[3:]

    async def test_iter_pages(self, router: respx.MockRouter) -> None:
        three_pages(router)
        page = await async_client().customers.list()
        sizes = [len(p.data) async for p in page.iter_pages()]
        assert sizes == [3, 3, 2]

    async def test_to_list_with_limit(self, router: respx.MockRouter) -> None:
        server = three_pages(router)
        items = await async_client().customers.list().to_list(limit=4)
        assert [c.id for c in items] == ALL[:4]
        assert len(server.calls) == 2
        assert len(await (await async_client().customers.list()).to_list()) == 8

    async def test_raw_response_parses_into_a_page(self, router: respx.MockRouter) -> None:
        three_pages(router)
        raw = await async_client().customers.with_raw_response.list(limit=3)
        assert raw.status_code == 200
        page = raw.parse()
        assert isinstance(page, AsyncPage)
        assert [c.id async for c in page] == ALL
