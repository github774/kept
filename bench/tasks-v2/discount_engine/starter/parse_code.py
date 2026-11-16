"""Parse a discount code. See SPEC.md section 1."""
from decimal import Decimal

from promo_common import parse_promo  # noqa: F401


def parse_code(code: str) -> dict:
    """Code -> {"kind": "pct" | "fixed", "value": Decimal}, decoded with ``promo_common.parse_promo``."""
    raise NotImplementedError
