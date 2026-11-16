from decimal import Decimal
import pytest
from parse_code import parse_code


@pytest.mark.parametrize("code,kind,val", [("PCT10", "pct", "10"), (" pct15 ", "pct", "15"), ("pct100", "pct", "100")])
def test_parse(code, kind, val):
    assert parse_code(code) == {"kind": kind, "value": Decimal(val)}


@pytest.mark.parametrize("code", ["", "PCT0", "PCT101", "OFF0", "OFF1000", "BOGO", "PCT-5", "PCT 10"])
def test_rejects(code):
    with pytest.raises(ValueError):
        parse_code(code)


def test_fixed_codes():
    assert parse_code(" off5 ") == {"kind": "fixed", "value": Decimal("5")}
    assert parse_code("OFF250") == {"kind": "fixed", "value": Decimal("250")}
