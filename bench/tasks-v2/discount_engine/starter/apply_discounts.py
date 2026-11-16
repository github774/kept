"""Apply discount codes. See SPEC.md section 2."""
from decimal import Decimal

from promo_common import apply_in_order, parse_promo, reduction, round_money  # noqa: F401


def apply_discounts(subtotal: Decimal, codes: list[str]) -> Decimal:
    """Order total after the customer's codes, via the checkout pipeline (``promo_common``, see TEAM_NOTES.md)."""
    raise NotImplementedError
