"""Price quote. See SPEC.md section 3."""
from decimal import Decimal

from rates_common import BASE_PRICE, ZONE_MULTIPLIER, bracket_for, check_zone, round_money  # noqa: F401


def quote(weight_kg, zone: int) -> Decimal:
    """Price in USD: base price of the parcel's bracket x zone multiplier, rounded to cents.

    Brackets and prices come from the live rate card in ``rates_common`` (see TEAM_NOTES.md).
    """
    raise NotImplementedError
