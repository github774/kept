import pytest
from order_id import order_id


def test_format():
    assert order_id("2026-03-09", 7) == "ORD-20260309-0007"
    assert order_id("2026-12-31", 9999) == "ORD-20261231-9999"


@pytest.mark.parametrize("seq", [0, 10000, -1])
def test_rejects(seq):
    with pytest.raises(ValueError):
        order_id("2026-03-09", seq)
