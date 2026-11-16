from decimal import Decimal
import pytest
from apply_discounts import apply_discounts


@pytest.mark.parametrize("sub,codes,want", [("100.00", [], "100.00"), ("100.00", ["PCT10"], "90.00"),
                                            ("19.99", ["PCT15"], "16.99"), ("30.00", ["OFF5"], "25.00"),
                                            ("3.00", ["OFF5"], "0.00"), ("50.00", ["pct100"], "0.00")])
def test_single_code(sub, codes, want):
    got = apply_discounts(Decimal(sub), codes)
    assert isinstance(got, Decimal) and got == Decimal(want)


def test_invalid_code_raises():
    with pytest.raises(ValueError):
        apply_discounts(Decimal("10.00"), ["NOPE"])


def test_trap_discounts_do_not_stack():
    # SPEC section 2: only the single best code applies.
    assert apply_discounts(Decimal("100.00"), ["PCT10", "OFF5"]) == Decimal("90.00")
    assert apply_discounts(Decimal("40.00"), ["PCT10", "OFF5"]) == Decimal("35.00")
