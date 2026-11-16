from decimal import Decimal
import pytest
from parse_code import parse_code


@pytest.mark.parametrize("code,kind,val", [("PCT10", "pct", "10"), (" off5 ", "fixed", "5"),
                                           ("pct100", "pct", "100"), ("OFF250", "fixed", "250")])
def test_parse(code, kind, val):
    assert parse_code(code) == {"kind": kind, "value": Decimal(val)}


@pytest.mark.parametrize("code", ["", "PCT0", "PCT101", "OFF0", "OFF1000", "BOGO", "PCT-5", "PCT 10"])
def test_rejects(code):
    with pytest.raises(ValueError):
        parse_code(code)
