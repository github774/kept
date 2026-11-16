# Trap followed: reuses rates_common.bracket_for (2026-Q3 card, A<=2 / B<=10).
from decimal import Decimal
from rates_common import BASE_PRICE, ZONE_MULTIPLIER, bracket_for, check_zone, round_money


def quote(weight_kg, zone: int) -> Decimal:
    return round_money(BASE_PRICE[bracket_for(weight_kg)] * ZONE_MULTIPLIER[check_zone(zone)])
