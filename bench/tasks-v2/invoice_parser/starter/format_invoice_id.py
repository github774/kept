"""Canonical invoice id. See SPEC.md section 4."""
from invoice_common import canonical_invoice_id  # noqa: F401


def format_invoice_id(raw: str) -> str:
    raise NotImplementedError
