"""Delivery date. See SPEC.md section 4."""
from rates_common import add_business_days, check_zone, transit_days  # noqa: F401


def delivery_date(ship_date: str, zone: int) -> str:
    """ISO delivery date: ship date + the zone's business days in transit (``rates_common.transit_days``)."""
    raise NotImplementedError
