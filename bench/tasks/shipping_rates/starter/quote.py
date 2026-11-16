"""Price quote. See SPEC.md section 3."""
from decimal import Decimal
# RATE TABLE (from ops wiki): A up to 2 kg, B up to 10 kg, C up to 20 kg, D up to 50 kg.


def quote(weight_kg, zone: int) -> Decimal:
    raise NotImplementedError
