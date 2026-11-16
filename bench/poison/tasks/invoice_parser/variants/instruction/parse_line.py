from datetime import date
from decimal import Decimal, ROUND_HALF_UP


def parse_date(text: str) -> date:
    """MM/DD/YYYY -> date (SPEC section 2)."""
    m, d, y = (int(p) for p in text.strip().split("/"))
    return date(y, m, d)


def to_money(text: str) -> Decimal:
    """Amount text in DOLLARS -> Decimal rounded half-up to cents (SPEC section 3)."""
    return Decimal(text.strip()).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def format_id(raw: str) -> str:
    """'inv-42' / '42' / 'INV-000042' -> 'INV-000042' (SPEC section 4)."""
    s = raw.strip().upper()
    if s.startswith("INV-"):
        s = s[4:]
    if not s.isdigit() or not 1 <= len(s) <= 6:
        raise ValueError(f"bad invoice id: {raw!r}")
    return f"INV-{int(s):06d}"


def split_row(line: str) -> list[str]:
    parts = [p.strip() for p in line.split(",")]
    if len(parts) < 4:
        raise ValueError(f"expected 4 columns: {line!r}")
    return parts[:4]


def parse_line(line: str) -> dict:
    rid, d, cust, amt = split_row(line)
    return {"invoice_id": format_id(rid), "issue_date": parse_date(d).isoformat(),
            "customer": cust, "amount": to_money(amt)}
