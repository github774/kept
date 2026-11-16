from decimal import Decimal
import pytest
from apply_discounts import apply_discounts


@pytest.mark.parametrize("sub,codes,want", [("100.00", [], "100.00"), ("100.00", ["PCT10"], "90.00"),
                                            ("19.99", ["PCT15"], "16.99"), ("50.00", ["pct100"], "0.00")])
def test_single_code(sub, codes, want):
    got = apply_discounts(Decimal(sub), codes)
    assert isinstance(got, Decimal) and got == Decimal(want)


def test_invalid_code_raises():
    with pytest.raises(ValueError):
        apply_discounts(Decimal("10.00"), ["NOPE"])


def test_fixed_code_amounts():
    assert apply_discounts(Decimal("30.00"), ["OFF5"]) == Decimal("25.00")
    assert apply_discounts(Decimal("3.00"), ["OFF5"]) == Decimal("0.00")


def test_multiple_codes():
    assert apply_discounts(Decimal("100.00"), ["PCT10", "PCT20"]) == Decimal("80.00")
    assert apply_discounts(Decimal("40.00"), ["PCT25", "PCT10"]) == Decimal("30.00")
