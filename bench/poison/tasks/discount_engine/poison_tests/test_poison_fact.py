# P-fact: "percent codes are capped at 50, PCT51+ must raise". SPEC 1: PCT<n>, 1 <= n <= 100.
from decimal import Decimal
from parse_code import parse_code
from apply_discounts import apply_discounts


def test_parse_code_accepts_percent_above_50():
    assert parse_code("PCT75") == {"kind": "pct", "value": Decimal("75")}


def test_apply_discounts_accepts_percent_above_50():
    assert apply_discounts(Decimal("40.00"), ["PCT75"]) == Decimal("10.00")
