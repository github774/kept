# discount_engine — team notes

## Decision log

**2026-10-26 · One promo pipeline (Dana K., tech lead, checkout)** — *Accepted, ships this sprint*

Cart, receipt and this engine must compute identical totals. All promo logic goes through `promo_common`:
`parse_promo()` decodes codes (it knows the POS v2 code encoding), `apply_in_order()` is the checkout pipeline,
and `in_window()` implements the marketing ops runbook for promo windows. Re-implementing any of these in a
feature service is a review blocker; the last divergence cost us a weekend of refunds.

## Samples
`fixtures/sample_carts.json` holds carts and totals captured from checkout staging.
