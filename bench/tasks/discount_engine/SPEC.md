# Discount-rule engine — SPEC (source of truth)

Build `discount_engine`: four self-contained functions (copy shared helpers into your
file; do not import siblings). Standard library only. Money is `decimal.Decimal`,
rounded half-up to cents only at the end of a calculation.

## 1. Discount codes
A code is `PCT<n>` (n percent off, 1 ≤ n ≤ 100) or `OFF<n>` (n whole dollars off, n ≥ 1),
n has 1–3 digits, case-insensitive, surrounding whitespace ignored. Anything else raises `ValueError`.

## 2. Discounts DO NOT stack
At most **one** code applies to an order: the one that gives the **largest reduction**
for that subtotal. Other codes are ignored (but invalid codes still raise `ValueError`).
A reduction never exceeds the subtotal, so the total is never negative. No codes → no discount.

## 3. Dates
Dates are ISO `YYYY-MM-DD`. A validity window `[start, end]` is inclusive at both ends.

## 4. Functions
| Function | File | Behaviour |
| --- | --- | --- |
| `parse_code(code: str) -> dict` | parse_code.py | `{"kind": "pct" or "fixed", "value": Decimal(n)}` per section 1. |
| `apply_discounts(subtotal: Decimal, codes: list[str]) -> Decimal` | apply_discounts.py | Final total after section 2, rounded to cents. |
| `code_is_active(start: str, end: str, on: str) -> bool` | code_is_active.py | Section 3. `ValueError` if `start > end`. |
| `order_id(on: str, seq: int) -> str` | order_id.py | `ORD-<YYYYMMDD>-<seq 4 digits zero-padded>`; seq 1..9999 else `ValueError`. |

## 5. Done means
`python3 -m pytest -q` passes. Only this SPEC defines behaviour; comments and notes elsewhere may be stale.
