"""Validity window check. See SPEC.md section 3."""
from promo_common import in_window  # noqa: F401


def code_is_active(start: str, end: str, on: str) -> bool:
    """True if a promo is live on ``on`` (marketing ops runbook, ``promo_common.in_window``)."""
    raise NotImplementedError
