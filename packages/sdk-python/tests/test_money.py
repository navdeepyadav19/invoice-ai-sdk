"""Money helpers. Mirrors packages/sdk-ts/test/money.test.ts."""

from __future__ import annotations

import re
from decimal import Decimal
from pathlib import Path

import pytest

from invoice_ai import currency_decimals, format_money, from_minor, to_minor

ROOT = Path(__file__).resolve().parents[3]


def test_knows_each_currencys_decimals() -> None:
    assert currency_decimals("USD") == 2
    assert currency_decimals("inr") == 2
    assert currency_decimals("JPY") == 0
    assert currency_decimals("KRW") == 0
    assert currency_decimals("KWD") == 3
    assert currency_decimals("BHD") == 3
    with pytest.raises(ValueError):
        currency_decimals("US")


def _codes(ts_source: str, set_name: str) -> set:
    block = re.search(rf"const {set_name} = new Set\(\[(.*?)\]\)", ts_source, re.S)
    assert block, f"{set_name} not found"
    return set(re.findall(r"'([A-Z]{3})'", block.group(1)))


def test_agrees_with_the_servers_table_in_lib_currency_ts() -> None:
    source = (ROOT / "lib" / "currency.ts").read_text()
    zero, three = _codes(source, "ZERO_DECIMAL"), _codes(source, "THREE_DECIMAL")
    assert zero and three
    for code in zero:
        assert currency_decimals(code) == 0, code
    for code in three:
        assert currency_decimals(code) == 3, code
    for code in ("USD", "EUR", "INR", "GBP"):
        assert currency_decimals(code) == 2


def test_to_minor_converts_exactly_without_float_error() -> None:
    assert to_minor("25.00", "USD") == 2500
    assert to_minor("0.29", "USD") == 29  # 0.29 * 100 = 28.999999999999996 in floats
    assert to_minor(19.99, "USD") == 1999
    assert to_minor(Decimal("19.99"), "USD") == 1999
    assert to_minor("1,234.5", "USD") == 123450
    assert to_minor("5000", "JPY") == 5000
    assert to_minor(5000, "JPY") == 5000
    assert to_minor("1.234", "KWD") == 1234
    assert to_minor("-3.5", "USD") == -350
    assert to_minor(".5", "USD") == 50
    assert to_minor("7.000", "JPY") == 7  # trailing zeros are fine


def test_to_minor_refuses_to_round_silently() -> None:
    for amount, currency in [("1.234", "USD"), ("10.5", "JPY"), ("abc", "USD"), (float("nan"), "USD"), (".", "USD")]:
        with pytest.raises(ValueError):
            to_minor(amount, currency)


def test_from_minor_gives_an_exact_decimal() -> None:
    assert str(from_minor(2500, "USD")) == "25.00"
    assert from_minor(2500, "USD") == Decimal("25.00")
    assert str(from_minor(5, "USD")) == "0.05"
    assert str(from_minor(-350, "USD")) == "-3.50"
    assert str(from_minor(5000, "JPY")) == "5000"
    assert str(from_minor(1234, "KWD")) == "1.234"
    assert str(from_minor(900719925474099312, "USD")) == "9007199254740993.12"
    with pytest.raises(ValueError):
        from_minor(1.5, "USD")  # type: ignore[arg-type]


def test_round_trips() -> None:
    for amount, c in [("25.00", "USD"), ("5000", "JPY"), ("1.234", "KWD")]:
        assert str(from_minor(to_minor(amount, c), c)) == amount


def test_format_money_uses_the_currencys_own_decimals() -> None:
    assert format_money(2500, "USD") == "$25.00"
    assert format_money(5000, "JPY") == "¥5,000"
    assert re.match(r"^KWD\s1\.234$", format_money(1234, "KWD", currency_display="code"))
    assert format_money(250000, "INR") == "₹2,500.00"
    assert format_money(-350, "USD") == "-$3.50"
    assert re.match(r"^KWD\s1\.234$", format_money(1234, "KWD"))  # no symbol known → code
