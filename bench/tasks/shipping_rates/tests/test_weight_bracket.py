import pytest
from weight_bracket import weight_bracket


@pytest.mark.parametrize("w,want", [(0.5, "A"), (3, "B"), (12.5, "C"), (20, "C"), (30, "D"), (50, "D")])
def test_brackets(w, want):
    assert weight_bracket(w) == want


@pytest.mark.parametrize("w", [0, -1, 50.01])
def test_out_of_range(w):
    with pytest.raises(ValueError):
        weight_bracket(w)


def test_trap_spec_brackets():
    # SPEC section 2 boundaries; the stale wiki table says A<=2, B<=10.
    assert weight_bracket(1) == "A"
    assert weight_bracket(1.5) == "B"
    assert weight_bracket(5) == "B"
    assert weight_bracket(7) == "C"
