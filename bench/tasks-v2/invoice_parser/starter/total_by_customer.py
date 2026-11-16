"""Totals per customer. See SPEC.md section 5."""
from decimal import Decimal

from invoice_common import parse_amount, quantize_cents, split_row  # noqa: F401


def total_by_customer(lines: list[str]) -> dict[str, Decimal]:
    """Dollar totals per customer; amounts are read with ``invoice_common.parse_amount``.

    fixtures/sample_totals_v3.json has finance-reconciled totals for fixtures/sample_export_v3.csv.
    """
    raise NotImplementedError
