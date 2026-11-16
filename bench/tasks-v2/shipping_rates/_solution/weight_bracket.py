from datetime import date, timedelta
from decimal import Decimal, ROUND_HALF_UP

# SPEC section 2: (upper bound inclusive in kg, bracket)
BRACKETS = [(Decimal("1"), "A"), (Decimal("5"), "B"), (Decimal("20"), "C"), (Decimal("50"), "D")]
BASE = {"A": Decimal("5.00"), "B": Decimal("8.50"), "C": Decimal("14.00"), "D": Decimal("25.00")}
ZONE_MULT = {1: Decimal("1.00"), 2: Decimal("1.25"), 3: Decimal("1.60")}
ZONE_DAYS = {1: 2, 2: 3, 3: 5}


def bracket_for(weight_kg) -> str:
    w = Decimal(str(weight_kg))
    if w <= 0:
        raise ValueError("weight must be > 0")
    for upper, name in BRACKETS:
        if w <= upper:
            return name
    raise ValueError("weight over 50 kg")


def round_money(x: Decimal) -> Decimal:
    return x.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def check_zone(zone: int) -> int:
    if zone not in ZONE_MULT:
        raise ValueError(f"bad zone {zone}")
    return zone


def weight_bracket(weight_kg) -> str:
    return bracket_for(weight_kg)
