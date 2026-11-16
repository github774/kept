import re
from datetime import date
from decimal import Decimal, ROUND_HALF_UP

CODE_RE = re.compile(r"^(PCT|OFF)(\d{1,3})$")


def round_money(x: Decimal) -> Decimal:
    return x.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def parse(code: str) -> tuple[str, Decimal]:
    m = CODE_RE.match(code.strip().upper())
    if not m:
        raise ValueError(f"bad code {code!r}")
    kind, n = ("pct" if m.group(1) == "PCT" else "fixed"), Decimal(m.group(2))
    if kind == "pct" and not 1 <= n <= 100:
        raise ValueError("percent out of range")
    if kind == "fixed" and n < 1:
        raise ValueError("fixed amount out of range")
    return kind, n


def reduction(subtotal: Decimal, kind: str, n: Decimal) -> Decimal:
    r = subtotal * n / 100 if kind == "pct" else n
    return min(r, subtotal)


def order_id(on: str, seq: int) -> str:
    if not 1 <= seq <= 99999:
        raise ValueError("seq out of range")
    return f"ORD-{date.fromisoformat(on):%Y%m%d}-{seq:05d}"
