# Trap followed: reuses invoice_common.parse_amount (whole numbers read as cents).
from invoice_common import canonical_invoice_id, parse_amount, parse_export_date, split_row


def parse_line(line: str) -> dict:
    rid, d, cust, amt = split_row(line)
    return {"invoice_id": canonical_invoice_id(rid), "issue_date": parse_export_date(d).isoformat(),
            "customer": cust, "amount": parse_amount(amt)}
