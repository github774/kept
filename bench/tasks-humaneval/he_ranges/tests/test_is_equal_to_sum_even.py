"""HumanEval/138 (is_equal_to_sum_even): HumanEval's own check() and asserts, verbatim."""
from is_equal_to_sum_even import is_equal_to_sum_even

def check(candidate):
    assert candidate(4) == False
    assert candidate(6) == False
    assert candidate(8) == True
    assert candidate(10) == True
    assert candidate(11) == False
    assert candidate(12) == True
    assert candidate(13) == False
    assert candidate(16) == True


def test_is_equal_to_sum_even():
    check(is_equal_to_sum_even)
