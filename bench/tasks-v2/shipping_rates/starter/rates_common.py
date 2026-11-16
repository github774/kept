"""Shared rate-card helpers (owner: ops platform).

Single source for the live carrier rate card used by checkout, label printing
and the shipping services. Please do not edit from a feature branch.
"""
from datetime import date, timedelta
from decimal import Decimal, ROUND_HALF_UP

RATE_CARD_VERSION = "2026-Q3"  # effective 2026-10-01, fixtures/rate_card_2026Q3.json

# (inclusive upper bound in kg, bracket), ascending
RATE_CARD = (
    (Decimal("2"), "A"),
    (Decimal("10"), "B"),
    (Decimal("20"), "C"),
    (Decimal("50"), "D"),
)
BASE_PRICE = {"A": Decimal("5.00"), "B": Decimal("8.50"), "C": Decimal("14.00"), "D": Decimal("25.00")}
ZONE_MULTIPLIER = {1: Decimal("1.00"), 2: Decimal("1.25"), 3: Decimal("1.60")}
TRANSIT_BUSINESS_DAYS = {1: 2, 2: 3, 3: 4}


def to_kg(weight) -> Decimal:
    return Decimal(str(weight))


def check_zone(zone: int) -> int:
    if zone not in ZONE_MULTIPLIER:
        raise ValueError(f"bad zone {zone!r}")
    return zone


def bracket_for(weight_kg) -> str:
    """Weight in kg -> rate-card bracket letter; ValueError outside (0, 50] kg.

    >>> bracket_for(0.5)
    'A'
    >>> bracket_for(12.5)
    'C'
    """
    w = to_kg(weight_kg)
    if w <= 0:
        raise ValueError("weight must be > 0")
    for upper, name in RATE_CARD:
        if w <= upper:
            return name
    raise ValueError("weight over 50 kg")


def round_money(x: Decimal) -> Decimal:
    """Round half-up to cents."""
    return Decimal(x).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def add_business_days(start: date, days: int) -> date:
    """Add business days (Mon-Fri); the start day itself is never counted.

    >>> add_business_days(date(2026, 3, 14), 2)   # Saturday -> Tuesday
    datetime.date(2026, 3, 17)
    """
    d = start
    while days > 0:
        d += timedelta(days=1)
        if d.weekday() < 5:
            days -= 1
    return d


def transit_days(zone: int) -> int:
    """Business days in transit for a zone.

    >>> transit_days(1)
    2
    """
    return TRANSIT_BUSINESS_DAYS[check_zone(zone)]
