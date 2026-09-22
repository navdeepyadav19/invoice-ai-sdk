from __future__ import annotations

import sys
from pathlib import Path
from typing import Iterator

import pytest
import respx

sys.path.insert(0, str(Path(__file__).parent))


@pytest.fixture
def router() -> Iterator[respx.MockRouter]:
    """Intercepts every httpx request; unmatched requests fail the test."""
    with respx.mock(assert_all_called=False) as r:
        yield r


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in ("INVOICE_AI_API_KEY", "INVOICE_AI_BASE_URL", "INVOICE_AI_LOG"):
        monkeypatch.delenv(name, raising=False)
