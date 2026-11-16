# Trap followed: reuses invoice_common.is_past_due (overdue ON the due date, FIN-7).
from datetime import date
from invoice_common import canonical_invoice_id, is_past_due, parse_export_date, split_row


def overdue_invoices(lines: list[str], as_of: str, terms_days: int = 30) -> list[str]:
    cutoff = date.fromisoformat(as_of)
    ids = []
    for line in lines:
        if not line.strip():
            continue
        rid, d, _, _ = split_row(line)
        if is_past_due(parse_export_date(d), cutoff, terms_days):
            ids.append(canonical_invoice_id(rid))
    return sorted(ids)
