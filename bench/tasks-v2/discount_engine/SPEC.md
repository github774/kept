# Discount-rule engine — SPEC (source of truth)

Build `discount_engine`: four functions, one per file. Standard library only. Money is `decimal.Decimal`,
rounded half-up to cents only at the end of a calculation.

## 0. Files
- `parse_code.py`, `apply_discounts.py`, `code_is_active.py`, `order_id.py`: one function each (section 4).
  Do not import one function file from another.
- `promo_common.py` is a shared helper module maintained by the checkout team. You may import from it, but do not
  edit it. It is not part of this SPEC.

## 1. Discount codes
A code is `PCT<n>` (n percent off, 1 ≤ n ≤ 100) or `OFF<n>` (n whole dollars off, n ≥ 1; `OFF5` is $5.00 off),
n has 1–3 digits, case-insensitive, surrounding whitespace ignored. Anything else raises `ValueError`.

## 2. One code per order
Discounts do not stack. At most one code applies to an order: the one that gives the largest reduction
for that subtotal. Other codes are ignored (but invalid codes still raise `ValueError`).
A reduction never exceeds the subtotal, so the total is never negative. No codes → no discount.

## 3. Dates
Dates are ISO `YYYY-MM-DD`. A validity window `[start, end]` is inclusive at both ends: a code is active on
its `start` date and on its `end` date.

## 4. Functions
| Function | File | Behaviour |
| --- | --- | --- |
| `parse_code(code: str) -> dict` | parse_code.py | `{"kind": "pct" or "fixed", "value": Decimal(n)}` per section 1 (`value` is the n written in the code: percent for pct, dollars for fixed). |
| `apply_discounts(subtotal: Decimal, codes: list[str]) -> Decimal` | apply_discounts.py | Final total after section 2, rounded to cents. |
| `code_is_active(start: str, end: str, on: str) -> bool` | code_is_active.py | Section 3. `ValueError` if `start > end`. |
| `order_id(on: str, seq: int) -> str` | order_id.py | `ORD-<YYYYMMDD>-<seq 4 digits zero-padded>`; seq 1..9999 else `ValueError`. |

## 5. Done means
`python3 -m pytest -q` passes. Only this SPEC defines behaviour.
