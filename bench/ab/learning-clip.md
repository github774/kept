# Learning clip (round 2, one run each side)

Task `invoicing_ab`, function `invoice_totals`. Same poison (billing_common.round_money silently switched to ROUND_HALF_EVEN
mid-run, file-level), same model (GPT-6 Luna), same code (commit with the stale-checkpoint and culprit-naming fixes).
Label: **one run**, not a rate; the rates are in docs/BENCHMARK.md "Feature A/B", round 2.

- WITH the lesson: herd ON, run `rvvvb`, agent `w2-g1-rvvvb` (poison at 53.703s; first step whose prompt carried a lesson naming round_money returned at 162s).
- WITHOUT: herd OFF, run `r4izf`, agent `w2-g1-r4izf` (poison at 50.909s).

Lesson that reached it (case `rvvvb.0.g1`, filed at 121s from slot 0's failure): "Do not call `billing_common.round_money`; round line net in `line_net.py` to the currency’s minor unit using `ROUND_HALF_UP`, as SPEC 2.2 requires."

## Lessons block in the WITH agent's prompt once the lesson arrived

```
## Fleet lessons (from case files, oldest first)

1. Do not call `billing_common.round_money`; round line net in `line_net.py` to the currency’s minor unit using `ROUND_HALF_UP`, as SPEC 2.2 requires.
2. Do not call billing_common.round_money; round locally with Decimal ROUND_HALF_UP per SPEC 2.2, including for same-currency conversions.
3. billing_common.round_money now uses half-even; do not call it in line_tax, and round line tax with ROUND_HALF_UP per SPEC 2.2.
4. billing_common.round_money uses the wrong negative tie rounding; in credit_note, round negative amounts per SPEC 2.2 using ROUND_HALF_UP.
```

## WITH the lesson: w2-g1-rvvvb

| t (s) | step | action | uses round_money | approach_note / summary |
| --- | --- | --- | --- | --- |
| 41.9 | 1 | write_code | yes | Implemented invoice validation, tax treatment selection, rounded line nets, and per-rate grouped tax aggregation using explicit SPEC rate tables and billing_common rounding. / Added invoice_totals.py. |
| 97.5 | 2 | run_tests | no | Run the owned invoice_totals test file to verify the implementation against its focused tests. / Running focused tests. |
| 126.8 | 3 | write_code | yes | Reimplemented invoice validation, treatment selection, rounded line-net summation, and per-rate grouped tax using explicit spec rate tables. This ensures precise fractional rates remain unrounded until group tax calculation. / Updated invoice_totals.py. |
| 161.5 | 4 | write_code | no | Reimplemented line validation, line-net rounding and grouped invoice tax locally with ROUND_HALF_UP, avoiding shared rounding behavior that produced both reported mismatches. / Updated invoice totals with local half-up rounding. |
| 198.5 | 5 | message | no | Acknowledged the conversion rounding lesson as it applies to negative credit-note money values. / Replied to the routed conversion case. |
| 225.9 | 6 | write_code | no | Implemented credit-note validation and signed return nets, derived the original invoice tax treatment, and aggregated negative tax by rate with local ROUND_HALF_UP currency rounding. / Credit note function implemented. |
| 250.7 | 7 | claim_done | no | Invoice totals implementation is complete; the recorded test run passed. / Implemented invoice totals with per-rate tax aggregation. |

Test runs: 54.5s PASS; 110.8s FAIL(test_distance_sale,test_only_exempt_and_export_kwd) [poison]; 143.6s FAIL(test_distance_sale,test_only_exempt_and_export_kwd) [poison]; 170.8s PASS; 233.6s PASS; 257.4s PASS

Outcome: retired no; final code follows the poison: no; final tests pass: yes.

## WITHOUT (herd OFF): w2-g1-r4izf

| t (s) | step | action | uses round_money | approach_note / summary |
| --- | --- | --- | --- | --- |
| 45.2 | 1 | write_code | yes | Implemented invoice validation, treatment selection, rounded line nets, and per-rate grouped tax using shared currency rounding. / Added invoice_totals implementation. |
| 108.5 | 2 | claim_done | no | Invoice totals implementation has been tested against its test file; per-rate grouping and totals are complete. / Invoice totals subtask complete. |

Test runs: 55.5s PASS; 121s FAIL(test_distance_sale,test_only_exempt_and_export_kwd) [poison]

Outcome: retired yes; final code follows the poison: no; final tests pass: yes.

Raw: bench/ab/learning-clip.json and bench/ab/results.fix.json. Round 1 (before the fixes) produced no clip: the
lesson named the rule, not the helper (docs/BENCHMARK.md "Feature A/B", Experiment 3).
