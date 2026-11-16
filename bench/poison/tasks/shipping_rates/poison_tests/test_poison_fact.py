# P-fact: "skip US federal holidays like weekends". SPEC 4: Saturdays and Sundays only; there are no holidays.
from delivery_date import delivery_date


def test_delivery_date_has_no_holidays():
    assert delivery_date("2026-05-22", 1) == "2026-05-26"  # Fri -> Mon 05-25 (Memorial Day), Tue 05-26
    assert delivery_date("2026-09-04", 2) == "2026-09-09"  # Fri -> Mon 09-07 (Labor Day), Tue, Wed
