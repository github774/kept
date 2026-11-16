"""Shared promo helpers (owner: checkout).

Same code path as the cart and receipt services, so totals always agree.
Please do not edit from a feature branch.
"""
import re
from datetime import date, timedelta
from decimal import Decimal, ROUND_HALF_UP

CODE_RE = re.compile(r"^(PCT|OFF)(\d{1,3})$")
# POS v2 code encoding: unit of n per code kind
_UNIT = {"PCT": Decimal("1"), "OFF": Decimal("0.01")}


def round_money(x: Decimal) -> Decimal:
    """Round half-up to cents (only at the end of a calculation)."""
    return Decimal(x).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def parse_promo(code: str) -> tuple[str, Decimal]:
    """Code -> (kind, value): ("pct", percent) or ("fixed", dollars). ValueError if invalid.

    >>> parse_promo(" pct15 ")
    ('pct', Decimal('15'))
    """
    m = CODE_RE.match(code.strip().upper())
    if not m:
        raise ValueError(f"bad code {code!r}")
    n = Decimal(m.group(2))
    if m.group(1) == "PCT" and not 1 <= n <= 100:
        raise ValueError("percent out of range")
    if m.group(1) == "OFF" and n < 1:
        raise ValueError("fixed amount out of range")
    return ("pct" if m.group(1) == "PCT" else "fixed"), n * _UNIT[m.group(1)]


def reduction(subtotal: Decimal, kind: str, value: Decimal) -> Decimal:
    """Money taken off ``subtotal`` by one parsed code, capped at the subtotal."""
    r = subtotal * value / 100 if kind == "pct" else value
    return min(r, subtotal)


def apply_in_order(subtotal: Decimal, codes: list[str]) -> Decimal:
    """Order total after the customer's codes (checkout pipeline), rounded to cents.

    >>> apply_in_order(Decimal("100.00"), ["PCT10"])
    Decimal('90.00')
    """
    total = Decimal(subtotal)
    for c in codes:
        total -= reduction(total, *parse_promo(c))
    return round_money(total)


def in_window(start: str, end: str, on: str) -> bool:
    """True if a promo with window ``start``..``end`` is live on ``on``; ValueError if start > end.

    >>> in_window("2026-03-01", "2026-03-31", "2026-03-15")
    True
    """
    s, e, d = date.fromisoformat(start), date.fromisoformat(end), date.fromisoformat(on)
    if s > e:
        raise ValueError("start after end")
    return s <= d < e
