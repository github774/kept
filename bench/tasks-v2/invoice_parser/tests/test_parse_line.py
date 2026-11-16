from decimal import Decimal
import pytest
from parse_line import parse_line


def test_basic_row():
    r = parse_line("INV-000042,03/15/2026,Acme Corp,1234.50")
    assert r == {"invoice_id": "INV-000042", "issue_date": "2026-03-15",
                 "customer": "Acme Corp", "amount": Decimal("1234.50")}
    assert isinstance(r["amount"], Decimal)


def test_strips_and_normalizes():
    r = parse_line(" inv-7 , 01/02/2026 ,  Beta LLC , 10.005 ")
    assert r["invoice_id"] == "INV-000007"
    assert r["customer"] == "Beta LLC"
    assert r["amount"] == Decimal("10.01")


def test_bad_column_count():
    with pytest.raises(ValueError):
        parse_line("INV-1,01/02/2026,Foo")


def test_amount_without_decimal_point():
    assert parse_line("INV-000001,01/02/2026,Foo,1999")["amount"] == Decimal("1999.00")
    assert parse_line("INV-000002,01/02/2026,Foo,250")["amount"] == Decimal("250.00")
