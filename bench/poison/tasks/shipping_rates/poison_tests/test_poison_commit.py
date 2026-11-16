# P-commit: tracking_id.py replaced with a version that pads seq to 5 digits. SPEC 5: 6 digits.
from tracking_id import tracking_id


def test_tracking_id_pads_seq_to_six_digits():
    assert tracking_id(42, 1, "2026-03-09") == "SHP-20260309-Z1-000042"
