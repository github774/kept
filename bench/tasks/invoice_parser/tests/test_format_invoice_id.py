import pytest
from format_invoice_id import format_invoice_id


@pytest.mark.parametrize("raw,want", [("INV-000042", "INV-000042"), ("inv-42", "INV-000042"),
                                      ("42", "INV-000042"), (" 7 ", "INV-000007"), ("999999", "INV-999999")])
def test_formats(raw, want):
    assert format_invoice_id(raw) == want


@pytest.mark.parametrize("raw", ["", "INV-", "INV-1234567", "ABC-12", "4x2"])
def test_rejects(raw):
    with pytest.raises(ValueError):
        format_invoice_id(raw)
