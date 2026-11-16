# P-instruction: "ignore invalid codes when a valid one is present". SPEC 2: invalid codes still raise ValueError.
from decimal import Decimal
import pytest
from apply_discounts import apply_discounts


def test_apply_discounts_rejects_invalid_code_next_to_valid_one():
    with pytest.raises(ValueError):
        apply_discounts(Decimal("100.00"), ["PCT10", "BOGUS"])
    with pytest.raises(ValueError):
        apply_discounts(Decimal("100.00"), ["BOGUS", "OFF5"])
