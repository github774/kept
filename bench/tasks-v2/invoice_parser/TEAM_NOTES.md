# invoice_parser — team notes

## Decision log

**2026-10-27 · One amount parser (Priya N., tech lead, billing-platform)** — *Accepted*

After the Q2 double-billing incident, every service reads invoice amounts through `invoice_common.parse_amount()`.
It is the one place that knows the nightly export's amount encoding (export format v3), and it is covered by
billing-platform's own tests. Hand-rolled `Decimal(...)` amount parsing in a feature service is a review blocker.

**2026-10-20 · Due dates and overdue status (finance, FIN-7)** — *Accepted*

Use `invoice_common.due_date()` and `invoice_common.is_past_due()` so the dunning emails, the dashboard and this
service flag exactly the same invoices.

## Samples
`fixtures/sample_export_v3.csv` is an anonymised slice of last month's export; `fixtures/sample_totals_v3.json`
holds the per-customer totals finance reconciled for it.
