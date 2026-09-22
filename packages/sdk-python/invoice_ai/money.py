"""
Money helpers. Every amount on the wire is an integer in the currency's
smallest unit (Stripe-style): 2500 is $25.00, 2500 is ¥2,500, 2500 is
KWD 2.500. These helpers convert with each currency's ISO 4217 exponent — the
same table the server uses (lib/currency.ts) — using ``Decimal``, never float
multiplication.
"""

from __future__ import annotations

import re
from decimal import Decimal, InvalidOperation
from typing import Mapping, Union

from typing_extensions import Literal

__all__ = ["currency_decimals", "format_money", "from_minor", "to_minor"]

#: Currencies whose minor unit isn't 1/100. Everything else has 2 decimals.
_DECIMALS: Mapping[str, int] = {
    # Zero-decimal
    **dict.fromkeys(
        [
            "BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW", "PYG",
            "RWF", "UGX", "UYI", "VND", "VUV", "XAF", "XOF", "XPF",
        ],
        0,
    ),
    # Three-decimal
    **dict.fromkeys(["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"], 3),
    # Four-decimal
    "CLF": 4,
    "UYW": 4,
}

_NBSP = chr(0xA0)  # Intl puts a no-break space between a code and the number.
_CODE_RE = re.compile(r"^[A-Z]{3}$")
_AMOUNT_RE = re.compile(r"^([+-]?)(\d*)(?:\.(\d*))?$")

Amount = Union[str, int, float, Decimal]


def currency_decimals(currency: str) -> int:
    """How many decimals a currency uses: USD 2, JPY 0, KWD 3."""
    code = currency.upper()
    if not _CODE_RE.match(code):
        raise ValueError(f"Not an ISO 4217 currency code: {currency}")
    return _DECIMALS.get(code, 2)


def to_minor(amount: Amount, currency: str) -> int:
    """
    A major-unit amount to integer minor units.

        to_minor("25.00", "USD") → 2500     to_minor(5000, "JPY") → 5000
        to_minor("1.234", "KWD") → 1234     to_minor("1.234", "USD") → ValueError

    Raises instead of rounding when the amount has more decimals than the currency.
    """
    decimals = currency_decimals(currency)
    if isinstance(amount, bool):
        raise ValueError(f"Not a decimal amount: {amount!r}")
    if isinstance(amount, Decimal):
        if not amount.is_finite():
            raise ValueError(f"Amount must be finite, got {amount}")
        text = format(amount, "f")
    elif isinstance(amount, int):
        text = str(amount)
    elif isinstance(amount, float):
        if amount != amount or amount in (float("inf"), float("-inf")):
            raise ValueError(f"Amount must be finite, got {amount}")
        # repr() is the shortest round-tripping form (19.99, not 19.989999…).
        text = format(Decimal(repr(amount)), "f")
    elif isinstance(amount, str):
        text = re.sub(r"[,_\s]", "", amount.strip())
    else:
        raise TypeError(f"Amount must be str, int, float or Decimal, got {type(amount).__name__}")

    m = _AMOUNT_RE.match(text)
    if not m or (m.group(2) == "" and (m.group(3) or "") == ""):
        raise ValueError(f"Not a decimal amount: {amount!r}")
    sign, whole, frac_raw = m.group(1), m.group(2), m.group(3) or ""
    frac = frac_raw.rstrip("0")
    if len(frac) > decimals:
        raise ValueError(f"{currency.upper()} allows {decimals} decimal place(s); got {amount}")
    value = int((whole or "0") + frac.ljust(decimals, "0"))
    return -value if sign == "-" and value != 0 else value


def from_minor(minor: int, currency: str) -> Decimal:
    """
    Integer minor units to an exact major-unit ``Decimal``.

        from_minor(2500, "USD") → Decimal("25.00")   from_minor(5000, "JPY") → Decimal("5000")
        from_minor(1234, "KWD") → Decimal("1.234")

    ``str()`` of the result is the exact decimal string (``"25.00"``).
    """
    decimals = currency_decimals(currency)
    if isinstance(minor, bool) or not isinstance(minor, int):
        raise ValueError(f"Minor units must be an integer, got {minor!r}")
    return Decimal(minor).scaleb(-decimals)


#: Symbols as ``Intl.NumberFormat('en-US', {currencyDisplay: 'symbol'})`` prints them.
_SYMBOLS: Mapping[str, str] = {
    "USD": "$",
    "EUR": "€",
    "GBP": "£",
    "JPY": "¥",
    "INR": "₹",
    "CNY": "CN¥",
    "KRW": "₩",
    "CAD": "CA$",
    "AUD": "A$",
    "NZD": "NZ$",
    "HKD": "HK$",
    "MXN": "MX$",
    "BRL": "R$",
    "TWD": "NT$",
    "ILS": "₪",
    "VND": "₫",
    "PHP": "₱",
    "XAF": "FCFA",
    "XOF": "F\u202fCFA",
}


def format_money(
    minor: int,
    currency: str,
    *,
    currency_display: Literal["symbol", "code"] = "symbol",
) -> str:
    """
    Minor units formatted for people (en-US style grouping).

        format_money(2500, "USD") → "$25.00"   format_money(5000, "JPY") → "¥5,000"
        format_money(1234, "KWD") → "KWD 1.234"
    """
    decimals = currency_decimals(currency)
    code = currency.upper()
    major = from_minor(minor, currency)
    try:
        number = f"{abs(major):,.{decimals}f}"
    except (InvalidOperation, ValueError):  # pragma: no cover - Decimal always formats
        number = str(abs(major))
    sign = "-" if major < 0 else ""
    symbol = _SYMBOLS.get(code) if currency_display == "symbol" else None
    if symbol is None:
        return f"{sign}{code}{_NBSP}{number}"
    return f"{sign}{symbol}{number}"
