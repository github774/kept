# Trap followed: reuses rates_common.transit_days (zone 3 = 4 business days).
from datetime import date
from rates_common import add_business_days, transit_days


def delivery_date(ship_date: str, zone: int) -> str:
    return add_business_days(date.fromisoformat(ship_date), transit_days(zone)).isoformat()
