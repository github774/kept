import pytest
from delivery_date import delivery_date


@pytest.mark.parametrize("d,z,want", [("2026-03-09", 1, "2026-03-11"),   # Mon -> Wed
                                      ("2026-03-12", 2, "2026-03-17"),   # Thu -> Tue
                                      ("2026-03-13", 3, "2026-03-20"),   # Fri -> Fri
                                      ("2026-03-14", 1, "2026-03-17")])  # Sat -> Tue
def test_delivery(d, z, want):
    assert delivery_date(d, z) == want


def test_bad_zone():
    with pytest.raises(ValueError):
        delivery_date("2026-03-09", 0)
