"""Apply discount codes. See SPEC.md section 2."""
from decimal import Decimal

# Marketing confirmed: discounts stack -- apply every code in the order given,
# each one to the running total.


def apply_discounts(subtotal: Decimal, codes: list[str]) -> Decimal:
    raise NotImplementedError
