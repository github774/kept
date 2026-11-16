"""HumanEval/134 (check_if_last_char_is_a_letter): HumanEval's own check() and asserts, verbatim."""
from check_if_last_char_is_a_letter import check_if_last_char_is_a_letter

def check(candidate):

    # Check some simple cases
    assert candidate("apple") == False
    assert candidate("apple pi e") == True
    assert candidate("eeeee") == False
    assert candidate("A") == True
    assert candidate("Pumpkin pie ") == False
    assert candidate("Pumpkin pie 1") == False
    assert candidate("") == False
    assert candidate("eeeee e ") == False
    assert candidate("apple pie") == False
    assert candidate("apple pi e ") == False

    # Check some edge cases that are easy to work out by hand.
    assert True



def test_check_if_last_char_is_a_letter():
    check(check_if_last_char_is_a_letter)
