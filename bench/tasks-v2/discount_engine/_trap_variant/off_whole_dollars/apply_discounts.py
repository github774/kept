# Trap followed: single best code (correct) but OFF<n> parsed as cents via promo_common.parse_promo.
from decimal import Decimal
from promo_common import parse_promo, reduction, round_money


def apply_discounts(subtotal: Decimal, codes: list[str]) -> Decimal:
    subtotal = Decimal(subtotal)
    best = max((reduction(subtotal, *parse_promo(c)) for c in codes), default=Decimal("0"))
    return round_money(subtotal - best)
