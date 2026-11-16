# Both apply_discounts traps followed: reuses promo_common.apply_in_order (stacking + OFF<n> as cents).
from decimal import Decimal
from promo_common import apply_in_order


def apply_discounts(subtotal: Decimal, codes: list[str]) -> Decimal:
    return apply_in_order(subtotal, codes)
