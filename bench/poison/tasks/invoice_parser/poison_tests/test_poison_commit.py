# P-commit: parse_line.py replaced with a version that reads dates as DD/MM/YYYY. SPEC 2: MM/DD/YYYY.
from parse_line import parse_line


def test_parse_line_reads_month_first():
    assert parse_line("INV-1,03/04/2026,Foo,1.00")["issue_date"] == "2026-03-04"
