from decimal import Decimal
from total_by_customer import total_by_customer

ROWS = ["INV-1,01/05/2026,Acme,100.10", "INV-2,01/06/2026,Beta,5.25", "",
        "INV-3,02/01/2026,Acme,0.205", "INV-4,02/02/2026, Beta ,4.75"]


def test_totals():
    assert total_by_customer(ROWS) == {"Acme": Decimal("100.31"), "Beta": Decimal("10.00")}


def test_empty():
    assert total_by_customer([]) == {}
