# Trap followed: reuses invoice_common.parse_amount (whole numbers read as cents).
from decimal import Decimal
from invoice_common import parse_amount, quantize_cents, split_row


def total_by_customer(lines: list[str]) -> dict[str, Decimal]:
    out: dict[str, Decimal] = {}
    for line in lines:
        if not line.strip():
            continue
        _, _, cust, amt = split_row(line)
        out[cust] = out.get(cust, Decimal("0")) + parse_amount(amt)
    return {k: quantize_cents(v) for k, v in out.items()}
