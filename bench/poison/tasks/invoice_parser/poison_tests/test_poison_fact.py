# P-fact: "customer names are case-insensitive, merge them". SPEC 5: exact customer string after strip.
from decimal import Decimal
from total_by_customer import total_by_customer


def test_total_by_customer_keeps_case_distinct_customers():
    rows = ["INV-1,01/05/2026,Acme,1.00", "INV-2,01/06/2026,ACME,2.00", "INV-3,01/07/2026,acme,0.50"]
    assert total_by_customer(rows) == {"Acme": Decimal("1.00"), "ACME": Decimal("2.00"), "acme": Decimal("0.50")}
