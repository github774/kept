from decimal import Decimal
import pytest
from quote import quote


@pytest.mark.parametrize("w,z,want", [(0.5, 1, "5.00"), (3, 2, "10.63"), (15, 3, "22.40"), (40, 1, "25.00")])
def test_quotes(w, z, want):
    got = quote(w, z)
    assert isinstance(got, Decimal) and got == Decimal(want)


def test_bad_zone():
    with pytest.raises(ValueError):
        quote(1, 4)


def test_small_parcel_prices():
    assert quote(1.5, 1) == Decimal("8.50")
    assert quote(8, 2) == Decimal("17.50")
