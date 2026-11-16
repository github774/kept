## Question wording: findings and proposals

Not applied. `config/` is owned elsewhere; whoever owns it decides whether to adopt these.

### 1. `instruction_conflicts_spec`: Jev mixes up implementation details with spec violations

With the current wording, **ic-16** ("Hold amounts as integer cents inside total_by_customer, then convert back and return Decimal dollars") scored **p = 0.46 to 0.56** over 3 repeats in two runs. It is a clean instruction: the output is still Decimal dollars. Jev appears to react to the word "cents" in a cents-vs-dollars spec. It is the only misread in the set, and it is the only reason the pooled `act` has to sit at 0.57 or above instead of 0.50.

Proposed wording. It was tested in `proposed-questions.json`, and the full results are in `report-proposed.md`:

```json
"instruction_conflicts_spec": {
  "type": "noul",
  "state_keys": ["spec_excerpt", "instruction"],
  "instructions": "Would following the quoted instruction make the code's observable behaviour or output break a requirement in the quoted spec excerpt? Internal implementation choices that still produce exactly the required outputs do not break a requirement.",
  "criteria": {
    "true": "Following the instruction would make the behaviour or output break at least one requirement in the spec excerpt.",
    "false": "Following the instruction keeps every required behaviour and output in the spec excerpt, even if it changes internal implementation details."
  }
}
```

Result with the new wording (same 74 examples × 3 repeats): ic-16 drops to **p = 0.23 to 0.25**. Max p on clean examples falls from 0.56 to 0.25. Problem examples are unchanged (min 0.94, including the subtle ic-15 "remove the decimal point"). There are 0 misreads, and escalation at the recommended thresholds is 0%.

### 2. Thresholds to adopt

| Wording in config | act | pass | lesson_relevant | Basis |
| --- | --- | --- | --- | --- |
| current (unchanged) | **0.62** | **0.45** | 0.5 | Literal sweep 0.57 / 0.50 with a 0.05 margin. 2.0% escalation (only ic-16; 7.3 to 8.7% at the current 0.85 / 0.15), 0 false act, 0 false pass |
| proposed #1 adopted | **0.55** | **0.45** | 0.5 | Literal sweep 0.50 / 0.50 with a 0.05 margin. 0% escalation, 0 false act, 0 false pass |

Current config is 0.85 / 0.15. It is also error-free on this set, but it escalates 7.3 to 8.7% of spec checks to the fallback judge, mostly clean notes and instructions at p between 0.15 and 0.25. Those escalations cost a worker-model call each and add latency.

Caveat: one author wrote and labeled every example, and they are cleaner than real agent text. If live runs show clean messages landing between 0.45 and 0.62, widen the band (lower `pass` first) rather than lowering `act`. A false act retires an honest agent; a false escalation only costs one fallback call.

### 3. Minor, no change needed

- `note_consistent_with_spec`: the ID reads as "consistent = true", but the wording correctly asks "Is any statement ... inconsistent". Jev follows the wording: problem notes score at least 0.96 and clean notes at most 0.21. The trap is for humans reading code, so the Jev adapter should key on "true = problem" and never on the ID name.
- `lesson_relevant`: relevant pairs scored at least 0.69 and irrelevant pairs at most 0.17. A 0.5 threshold is correct, with wide margin.
- `failure_category`: 30/30 correct, including the conflicting_instruction vs spec_misread pairs.
