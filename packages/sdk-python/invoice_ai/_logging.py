"""
Debug logging with secrets redacted.

Turn it on with ``InvoiceAI(log_level="debug")`` or ``INVOICE_AI_LOG=debug``.
It prints method, path, status, request id and each retry decision through
the standard ``logging`` module (logger name ``invoice_ai``). The API key
never appears: it's shortened to ``inv_live_ab12cd34…``, and webhook secrets
to ``whsec_…``.
"""

from __future__ import annotations

import logging
import os
import re
from typing import Any, Callable, Dict, Iterable, List, Mapping, Optional, Tuple, Union

from typing_extensions import Literal

LogLevel = Literal["off", "error", "warn", "info", "debug"]

_ORDER: Dict[str, int] = {"off": 0, "error": 1, "warn": 2, "info": 3, "debug": 4}
_STDLIB: Dict[str, int] = {
    "error": logging.ERROR,
    "warn": logging.WARNING,
    "info": logging.INFO,
    "debug": logging.DEBUG,
}

logger = logging.getLogger("invoice_ai")


def parse_log_level(value: Optional[str]) -> Optional[LogLevel]:
    v = (value or "").strip().lower()
    if v == "warning":
        v = "warn"
    return v if v in _ORDER else None  # type: ignore[return-value]


def read_env(name: str) -> Optional[str]:
    """An environment variable, or None when unset or blank."""
    value = os.environ.get(name)
    if value is None or value.strip() == "":
        return None
    return value.strip()


class SDKLogger:
    """Drops anything below ``level`` and redacts what it keeps."""

    def __init__(self, level: Optional[LogLevel] = None) -> None:
        effective = level or parse_log_level(read_env("INVOICE_AI_LOG")) or "warn"
        self.level: LogLevel = effective
        # An explicit level must actually print, even if the app never configured logging.
        if level is not None or read_env("INVOICE_AI_LOG") is not None:
            _ensure_output(effective)

    def _emit(self, at: str, message: str) -> None:
        if _ORDER[self.level] < _ORDER[at]:
            return
        logger.log(_STDLIB[at], "[invoice-ai] %s", redact_secrets(message))

    def error(self, message: str) -> None:
        self._emit("error", message)

    def warn(self, message: str) -> None:
        self._emit("warn", message)

    def info(self, message: str) -> None:
        self._emit("info", message)

    def debug(self, message: str) -> None:
        self._emit("debug", message)

    def is_debug(self) -> bool:
        return self.level == "debug"


def _ensure_output(level: str) -> None:
    if level == "off":
        return
    stdlib_level = _STDLIB[level]
    if logger.level == logging.NOTSET or logger.level > stdlib_level:
        logger.setLevel(stdlib_level)
    if not logger.handlers and not logging.getLogger().handlers:
        handler = logging.StreamHandler()
        handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
        logger.addHandler(handler)


_KEY_PREFIX = re.compile(r"^(inv_[a-z]+_[A-Za-z0-9]{1,8})")


def redact_api_key(key: str) -> str:
    """``inv_live_ab12cd34_secret…`` → ``inv_live_ab12cd34…``. Unknown shapes keep 4 chars."""
    m = _KEY_PREFIX.match(key)
    if m:
        return f"{m.group(1)}…"
    return "…" if len(key) <= 4 else f"{key[:4]}…"


_SECRET_PATTERNS: List[Tuple[re.Pattern[str], Callable[[str], str]]] = [
    (re.compile(r"inv_[a-z]+_[A-Za-z0-9]+_[A-Za-z0-9_-]+"), redact_api_key),
    (re.compile(r"whsec_[A-Za-z0-9+/=_-]+"), lambda _m: "whsec_…"),
]


def redact_secrets(text: str) -> str:
    """Redacts API keys and webhook secrets anywhere in a string."""
    out = text
    for pattern, fn in _SECRET_PATTERNS:
        out = pattern.sub(lambda m, fn=fn: fn(m.group(0)), out)  # type: ignore[misc]
    return out


_SENSITIVE_HEADERS = frozenset({"authorization", "cookie", "set-cookie", "x-api-key"})

HeadersLike = Union[Mapping[str, str], Iterable[Tuple[str, str]]]


def redact_headers(headers: Any) -> Dict[str, str]:
    """A plain-dict copy of headers that is safe to print (lower-cased names)."""
    items: Iterable[Tuple[str, str]] = headers.items() if hasattr(headers, "items") else headers
    out: Dict[str, str] = {}
    for name, value in items:
        lower = name.lower()
        if lower == "authorization":
            token = re.sub(r"^Bearer\s+", "", value, flags=re.IGNORECASE)
            out[lower] = f"Bearer {redact_api_key(token)}"
        elif lower in _SENSITIVE_HEADERS:
            out[lower] = "[redacted]"
        else:
            out[lower] = redact_secrets(value)
    return out
