# Trap followed: reuses promo_common.in_window (half-open [start, end)).
from promo_common import in_window


def code_is_active(start: str, end: str, on: str) -> bool:
    return in_window(start, end, on)
