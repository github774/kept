from overdue_invoices import overdue_invoices

ROWS = ["INV-3,01/01/2026,Acme,10.00", "inv-1,02/15/2026,Beta,5.00", "",
        "2,03/01/2026,Acme,1.00", "INV-4,01/31/2026,Gamma,2.00"]


def test_default_terms():
    # due dates: #3 01-31, #1 03-17, #2 03-31, #4 03-02
    assert overdue_invoices(ROWS, "2026-03-03") == ["INV-000003", "INV-000004"]


def test_strictly_before():
    assert overdue_invoices(ROWS, "2026-01-31") == []
    assert overdue_invoices(ROWS, "2026-02-01") == ["INV-000003"]


def test_custom_terms():
    assert overdue_invoices(ROWS, "2026-03-03", terms_days=0) == ["INV-000001", "INV-000002", "INV-000003", "INV-000004"]
