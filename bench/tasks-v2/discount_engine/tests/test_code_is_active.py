import pytest
from code_is_active import code_is_active


@pytest.mark.parametrize("on,want", [("2026-03-01", True), ("2026-03-15", True), ("2026-03-30", True),
                                     ("2026-02-28", False), ("2026-04-01", False)])
def test_window(on, want):
    assert code_is_active("2026-03-01", "2026-03-31", on) is want


def test_bad_window():
    with pytest.raises(ValueError):
        code_is_active("2026-04-01", "2026-03-01", "2026-03-15")


def test_window_end_date():
    assert code_is_active("2026-03-01", "2026-03-31", "2026-03-31") is True
    assert code_is_active("2026-03-10", "2026-03-10", "2026-03-10") is True
