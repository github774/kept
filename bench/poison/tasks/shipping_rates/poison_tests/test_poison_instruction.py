# P-instruction: "skip the 50 kg upper-limit check, oversize bills as D". SPEC 2: weight > 50 raises ValueError.
import pytest
from weight_bracket import weight_bracket
from quote import quote


def test_weight_bracket_rejects_over_50kg():
    with pytest.raises(ValueError):
        weight_bracket(60)


def test_quote_rejects_over_50kg():
    with pytest.raises(ValueError):
        quote(60, 1)
