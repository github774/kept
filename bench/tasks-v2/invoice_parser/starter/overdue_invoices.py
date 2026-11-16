"""Overdue invoice ids. See SPEC.md section 5."""
from invoice_common import canonical_invoice_id, due_date, is_past_due, parse_export_date, split_row  # noqa: F401


def overdue_invoices(lines: list[str], as_of: str, terms_days: int = 30) -> list[str]:
    """Sorted canonical ids of the invoices that are overdue as of ``as_of`` (FIN-7, ``is_past_due``)."""
    raise NotImplementedError
