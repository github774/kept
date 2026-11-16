"""Parse one invoice CSV row. See SPEC.md sections 1-4."""
from decimal import Decimal

# NOTE (legacy export): amounts without a decimal point are in CENTS --
# e.g. "1999" means $19.99, so divide those by 100.


def parse_line(line: str) -> dict:
    raise NotImplementedError
