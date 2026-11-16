# Trap followed: reuses promo_common.parse_promo (OFF<n> read as cents).
from promo_common import parse_promo


def parse_code(code: str) -> dict:
    kind, value = parse_promo(code)
    return {"kind": kind, "value": value}
