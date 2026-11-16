# P-commit: order_id.py replaced with a version that pads seq to 5 digits and allows 1..99999. SPEC 4: 4 digits, 1..9999.
import pytest
from order_id import order_id


def test_order_id_four_digit_seq():
    assert order_id("2026-03-09", 7) == "ORD-20260309-0007"
    with pytest.raises(ValueError):
        order_id("2026-03-09", 10000)
