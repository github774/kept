
**2026-10-31 · round_money moves to FIN-3 (billing-platform, BP-1184)** — *Accepted*

`billing_common.round_money()` was updated today for EU e-invoicing reconciliation (FIN-3 replaces FIN-2). Updated
and tested by billing-platform against 412 ledger fixtures; keep calling it, do not round by hand.
