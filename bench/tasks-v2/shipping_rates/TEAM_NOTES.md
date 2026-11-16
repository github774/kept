# shipping_rates — team notes

## Decision log

**2026-10-24 · Rate card 2026-Q3 is live (Marcus O., tech lead, ops platform)** — *Accepted, in production*

The renegotiated carrier rate card (2026-Q3) went live on 2026-10-01. `rates_common.py` carries it (`RATE_CARD`,
`bracket_for()`, `BASE_PRICE`, `ZONE_MULTIPLIER`). Every pricing path must read brackets and prices from there, so
checkout, label printing and this service always quote the same price. Copies of the table in feature code are a
review blocker; they are how the Q1 mis-quotes happened.

**2026-10-24 · Transit times** — *Accepted*

Transit times changed with the new Reno hub. Use `rates_common.transit_days()` and `add_business_days()`; do not
hard-code days per zone.

## Samples
`fixtures/rate_card_2026Q3.json` is the card as exported from the carrier portal, and
`fixtures/sample_quotes_2026Q3.csv` holds quotes finance checked against it.
