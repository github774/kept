"""Tracking id. See SPEC.md section 5."""
from rates_common import check_zone  # noqa: F401


def tracking_id(seq: int, zone: int, ship_date: str) -> str:
    raise NotImplementedError
