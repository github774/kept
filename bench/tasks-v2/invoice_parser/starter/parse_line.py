"""Parse one invoice CSV row. See SPEC.md sections 1-4."""
from decimal import Decimal

from invoice_common import canonical_invoice_id, parse_amount, parse_export_date, split_row  # noqa: F401


def parse_line(line: str) -> dict:
    """Parse one export row into {"invoice_id", "issue_date", "customer", "amount"}.

    ``amount`` is Decimal dollars as returned by ``invoice_common.parse_amount`` (see TEAM_NOTES.md).

    >>> parse_line("INV-000042,03/15/2026,Acme Corp,1234.50")["amount"]
    Decimal('1234.50')
    """
    raise NotImplementedError
