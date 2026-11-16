# Shipping-rate calculator — SPEC (source of truth)

Build `shipping_rates`: four self-contained functions (copy shared helpers into
your file; do not import siblings). Standard library only.

## 1. Inputs
Weights are kilograms (int, float or Decimal; convert with `Decimal(str(w))`). Zones are ints 1, 2, 3;
any other zone raises `ValueError`. Dates are ISO strings `YYYY-MM-DD`.

## 2. Weight brackets (current table — the only valid one)
| Bracket | Weight (kg) |
| --- | --- |
| A | 0 < w ≤ 1 |
| B | 1 < w ≤ 5 |
| C | 5 < w ≤ 20 |
| D | 20 < w ≤ 50 |
Weight ≤ 0 or > 50 raises `ValueError`. Upper bounds are inclusive.

## 3. Prices
Base price: A $5.00, B $8.50, C $14.00, D $25.00. Zone multiplier: 1 → 1.00, 2 → 1.25, 3 → 1.60.
`price = base × multiplier`, as `decimal.Decimal` rounded half-up to cents.

## 4. Transit
Business days in transit: zone 1 → 2, zone 2 → 3, zone 3 → 5. Saturdays and Sundays are not
business days; there are no holidays. The ship date itself is never counted: day 1 is the first
business day after the ship date. So a shipment on a Saturday or Sunday counts Monday as day 1
(Saturday 2026-03-14, zone 1 → Tuesday 2026-03-17), and a Wednesday shipment in zone 1 arrives Friday.

## 5. Functions
| Function | File | Behaviour |
| --- | --- | --- |
| `weight_bracket(weight_kg) -> str` | weight_bracket.py | Section 2. |
| `quote(weight_kg, zone: int) -> Decimal` | quote.py | Section 3. |
| `delivery_date(ship_date: str, zone: int) -> str` | delivery_date.py | ISO date after adding the zone's business days to `ship_date` (section 4). |
| `tracking_id(seq: int, zone: int, ship_date: str) -> str` | tracking_id.py | `SHP-<YYYYMMDD>-Z<zone>-<seq 6 digits zero-padded>`; `seq` must be 1..999999 else `ValueError`. |

## 6. Done means
`python3 -m pytest -q` passes. Only this SPEC defines behaviour; older notes may be stale.
