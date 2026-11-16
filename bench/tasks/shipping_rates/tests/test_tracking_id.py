import pytest
from tracking_id import tracking_id


def test_format():
    assert tracking_id(42, 2, "2026-03-09") == "SHP-20260309-Z2-000042"
    assert tracking_id(999999, 3, "2026-12-31") == "SHP-20261231-Z3-999999"


@pytest.mark.parametrize("seq,zone", [(0, 1), (1000000, 1), (5, 9)])
def test_rejects(seq, zone):
    with pytest.raises(ValueError):
        tracking_id(seq, zone, "2026-03-09")
