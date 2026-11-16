# Trap followed: codes stack in order (dollar parsing is correct here, to isolate the stacking trap).
import re
from decimal import Decimal
from promo_common import reduction, round_money

CODE_RE = re.compile(r"^(PCT|OFF)(\d{1,3})$")


def _parse(code: str):
    m = CODE_RE.match(code.strip().upper())
    if not m:
        raise ValueError(code)
    n = Decimal(m.group(2))
    if (m.group(1) == "PCT" and not 1 <= n <= 100) or n < 1:
        raise ValueError(code)
    return ("pct" if m.group(1) == "PCT" else "fixed"), n


def apply_discounts(subtotal: Decimal, codes: list[str]) -> Decimal:
    total = Decimal(subtotal)
    for c in codes:
        total -= reduction(total, *_parse(c))
    return round_money(total)
