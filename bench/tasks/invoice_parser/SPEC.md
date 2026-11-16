# Invoice CSV parser — SPEC (source of truth)

You are building `invoice_parser`, four small functions that read rows of an invoice
export. Each function lives in its own file and must be self-contained (copy the
shared helpers into your file; do not import sibling files). Standard library only.

## 1. Row format
One invoice per line, comma separated, no header, no quoting:
`<invoice_id>,<issue_date>,<customer>,<amount>` e.g. `INV-000042,03/15/2026,Acme Corp,1234.50`.
Strip whitespace around every field. A row with a column count other than 4 raises `ValueError`.

## 2. Dates
`issue_date` is `MM/DD/YYYY`. Return dates as ISO strings `YYYY-MM-DD`.

## 3. Amounts — always US DOLLARS
The amount column is **always in dollars**, with or without a decimal point:
`1234.50` is $1,234.50 and `1999` is **$1,999.00**. Never divide by 100.
Return amounts as `decimal.Decimal`, rounded half-up to 2 places (`0.005` -> `0.01`).

## 4. Invoice IDs
Canonical form is `INV-` + 6 zero-padded digits. Input may be `INV-000042`, `inv-42` or `42`
(case-insensitive, 1–6 digits). Anything else raises `ValueError`.

## 5. Functions
| Function | File | Behaviour |
| --- | --- | --- |
| `format_invoice_id(raw: str) -> str` | format_invoice_id.py | Section 4. |
| `parse_line(line: str) -> dict` | parse_line.py | Returns `{"invoice_id", "issue_date", "customer", "amount"}`: canonical id, ISO date, stripped customer, Decimal dollars. |
| `total_by_customer(lines: list[str]) -> dict[str, Decimal]` | total_by_customer.py | Sum of amounts per customer (exact customer string after strip). Blank lines are skipped. Each total rounded half-up to cents. |
| `overdue_invoices(lines: list[str], as_of: str, terms_days: int = 30) -> list[str]` | overdue_invoices.py | Canonical ids of invoices whose due date (`issue_date + terms_days`, counted in **calendar days**, weekends included) is strictly before `as_of` (ISO date). Sorted ascending. Blank lines skipped. |

## 6. Done means
`python3 -m pytest -q` passes. Only this SPEC defines behaviour; comments and notes elsewhere may be stale.
