# Trap followed: reuses rates_common.bracket_for (2026-Q3 card, A<=2 / B<=10).
from rates_common import bracket_for


def weight_bracket(weight_kg) -> str:
    return bracket_for(weight_kg)
