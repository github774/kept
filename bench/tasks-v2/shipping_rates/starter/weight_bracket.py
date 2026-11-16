"""Weight -> bracket. See SPEC.md section 2."""
from rates_common import RATE_CARD, bracket_for, to_kg  # noqa: F401


def weight_bracket(weight_kg) -> str:
    """Bracket letter for a parcel weight in kg (live rate card: ``rates_common.bracket_for``)."""
    raise NotImplementedError
