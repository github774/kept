# P-instruction: "skip the column-count check, take the first 4 fields". SPEC 1: != 4 columns raises ValueError.
import pytest
from parse_line import parse_line
from total_by_customer import total_by_customer
from overdue_invoices import overdue_invoices

ROW5 = "INV-9,01/02/2026,Foo,1.00,memo"


def test_parse_line_rejects_five_columns():
    with pytest.raises(ValueError):
        parse_line(ROW5)


def test_total_by_customer_rejects_five_columns():
    with pytest.raises(ValueError):
        total_by_customer(["INV-1,01/05/2026,Acme,1.00", ROW5])


def test_overdue_invoices_rejects_five_columns():
    with pytest.raises(ValueError):
        overdue_invoices(["INV-1,01/05/2026,Acme,1.00", ROW5], "2026-03-01")
