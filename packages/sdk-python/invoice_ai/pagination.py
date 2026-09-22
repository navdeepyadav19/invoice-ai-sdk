"""
Cursor pagination.

``list()`` returns one page (``data``, ``next_cursor``, ``has_more``), and the
same object walks every page when you loop over it:

    page = client.invoices.list(limit=50)                 # one page
    for inv in client.invoices.list():                    # every invoice
        ...
    first_500 = client.invoices.list().to_list(limit=500)

Async:

    page = await client.invoices.list(limit=50)           # one page
    async for inv in client.invoices.list():              # every invoice
        ...
    first_500 = await client.invoices.list().to_list(limit=500)

Endpoints that return a plain array (no ``next_cursor``) produce a single page
with ``has_more == False``, so the same code works everywhere.
"""

from __future__ import annotations

from typing import (
    Any,
    AsyncIterator,
    Awaitable,
    Callable,
    Generator,
    Generic,
    Iterator,
    List,
    Optional,
    Tuple,
    TypeVar,
)

from ._response import ResponseMeta

__all__ = ["AsyncPage", "AsyncPagePromise", "SyncPage"]

T = TypeVar("T")


def _parse_body(body: Any, parse_item: Callable[[Any], T]) -> Tuple[List[T], Optional[str]]:
    b = body if isinstance(body, dict) else {}
    raw = b.get("data")
    data = [parse_item(item) for item in raw] if isinstance(raw, list) else []
    cursor = b.get("next_cursor")
    return data, cursor if isinstance(cursor, str) and cursor != "" else None


class _BasePage(Generic[T]):
    #: The items on this page.
    data: List[T]
    #: Pass as ``cursor`` to get the next page; None on the last page.
    next_cursor: Optional[str]
    has_more: bool
    #: Response metadata of the request that loaded this page.
    response: ResponseMeta

    def __init__(self, body: Any, response: ResponseMeta, parse_item: Callable[[Any], T]) -> None:
        self.data, self.next_cursor = _parse_body(body, parse_item)
        self.has_more = self.next_cursor is not None
        self.response = response

    def has_next_page(self) -> bool:
        return self.has_more

    def __repr__(self) -> str:
        return f"<{type(self).__name__} items={len(self.data)} next_cursor={self.next_cursor!r}>"


class SyncPage(_BasePage[T]):
    """One page. Iterating it yields every item on this page and the pages after it."""

    def __init__(
        self,
        body: Any,
        response: ResponseMeta,
        parse_item: Callable[[Any], T],
        fetch_next: Callable[[str], SyncPage[T]],
    ) -> None:
        super().__init__(body, response, parse_item)
        self._fetch_next = fetch_next

    def get_next_page(self) -> Optional[SyncPage[T]]:
        """The next page, or None when this is the last one."""
        return None if self.next_cursor is None else self._fetch_next(self.next_cursor)

    def iter_pages(self) -> Iterator[SyncPage[T]]:
        """This page and every page after it."""
        page: Optional[SyncPage[T]] = self
        while page is not None:
            yield page
            page = page.get_next_page()

    def __iter__(self) -> Iterator[T]:
        for page in self.iter_pages():
            yield from page.data

    def to_list(self, limit: Optional[int] = None) -> List[T]:
        """Collects items across pages, up to ``limit`` if given."""
        out: List[T] = []
        if limit is not None and limit <= 0:
            return out
        for item in self:
            out.append(item)
            if limit is not None and len(out) >= limit:
                break
        return out


class AsyncPage(_BasePage[T]):
    """One page. ``async for`` over it yields every item on this page and the pages after it."""

    def __init__(
        self,
        body: Any,
        response: ResponseMeta,
        parse_item: Callable[[Any], T],
        fetch_next: Callable[[str], Awaitable[AsyncPage[T]]],
    ) -> None:
        super().__init__(body, response, parse_item)
        self._fetch_next = fetch_next

    async def get_next_page(self) -> Optional[AsyncPage[T]]:
        """The next page, or None when this is the last one."""
        return None if self.next_cursor is None else await self._fetch_next(self.next_cursor)

    async def iter_pages(self) -> AsyncIterator[AsyncPage[T]]:
        """This page and every page after it."""
        page: Optional[AsyncPage[T]] = self
        while page is not None:
            yield page
            page = await page.get_next_page()

    async def __aiter__(self) -> AsyncIterator[T]:
        async for page in self.iter_pages():
            for item in page.data:
                yield item

    async def to_list(self, limit: Optional[int] = None) -> List[T]:
        """Collects items across pages, up to ``limit`` if given."""
        return await _collect(self.__aiter__(), limit)


class AsyncPagePromise(Generic[T]):
    """
    What async ``list()`` returns: ``await`` it for one page, or ``async for``
    over it for every item.
    """

    def __init__(self, load: Callable[[], Awaitable[Any]]) -> None:
        self._load = load

    def __await__(self) -> Generator[Any, None, AsyncPage[T]]:
        result: AsyncPage[T] = yield from self._load().__await__()
        return result

    async def __aiter__(self) -> AsyncIterator[T]:
        page: AsyncPage[T] = await self
        async for item in page:
            yield item

    async def to_list(self, limit: Optional[int] = None) -> List[T]:
        """Collects items across pages, up to ``limit`` if given."""
        return await _collect(self.__aiter__(), limit)


async def _collect(source: AsyncIterator[T], limit: Optional[int]) -> List[T]:
    out: List[T] = []
    if limit is not None and limit <= 0:
        return out
    async for item in source:
        out.append(item)
        if limit is not None and len(out) >= limit:
            break
    return out
