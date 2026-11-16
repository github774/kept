# Design Critique Rubric -- Reference

## Scoring bands

| Score | Band | Meaning |
|---|---|---|
| 28-35 | Excellent | Publication-ready. Minor polish only. |
| 21-27 | Good | Solid foundation. 1-2 dimensions need refinement. |
| 14-20 | Adequate | Works but feels unpolished. 2-3 structural issues. |
| 7-13 | Weak | Multiple structural problems. Needs significant rework. |
| 1-6 | Broken | Does not function as a designed interface. Start over. |

## Gotchas

1. **Hierarchy and contrast are not the same thing.** High contrast between two elements does not mean the hierarchy is correct. A bright red error message has high contrast but should not be the most prominent element on an empty-state page. Hierarchy is about importance, not loudness.
2. **Rhythm can be correct but boring.** A page with perfectly consistent 24px spacing everywhere is rhythmically correct but monotonous. Good rhythm has variation: tighter spacing within groups, larger spacing between groups.
3. **Density depends on the user's expertise.** A Bloomberg Terminal is extremely dense, but its users need that density. A consumer banking app should be less dense. "Too dense" is relative to the audience.
4. **Motion scores often start at N/A.** If the design is a static mockup, skip motion. If the design is a prototype with no animation, score it as intentional stillness (3/5) not as missing motion (1/5).
5. **Copy is frequently outside the designer's control.** If the copy is placeholder, note it but do not let it drag down the overall score. If the copy is final, it is as much a design element as any visual.

## Additional recipes

### Comparative critique (A vs B)
Score two designs side by side to make a recommendation.
```
COMPARATIVE CRITIQUE
Design A: [description]
Design B: [description]

| Dimension | A score | B score | Notes |
|---|---|---|---|
| Hierarchy | _/5 | _/5 | |
| Contrast | _/5 | _/5 | |
| Alignment | _/5 | _/5 | |
| Rhythm | _/5 | _/5 | |
| Density | _/5 | _/5 | |
| Motion | _/5 | _/5 | |
| Copy | _/5 | _/5 | |
| TOTAL | _/35 | _/35 | |

Recommendation: [A or B], because [specific reasoning tied to the highest-impact dimension].
Carry forward from the other: [specific element or decision from the non-chosen design worth keeping].
```

### Stakeholder-friendly critique summary
A one-paragraph summary for non-designers.
```
EXECUTIVE SUMMARY
The [page/screen] effectively [what it does well, 1 sentence].
The primary issue is [biggest problem, stated as a user impact, not a design term].
Fixing [specific prescription] will [specific user outcome].
Estimated effort: [small/medium/large].
```

### Iteration tracking table
Track scores across design iterations to show progress.
```
ITERATION TRACKER
| Dimension | v1 | v2 | v3 | Target |
|---|---|---|---|---|
| Hierarchy | 2 | 3 | 4 | 4+ |
| Contrast | 3 | 3 | 4 | 4+ |
| Alignment | 4 | 4 | 5 | 4+ |
| Rhythm | 2 | 3 | 3 | 3+ |
| Density | 3 | 4 | 4 | 4+ |
| Motion | 1 | 2 | 3 | 3+ |
| Copy | 2 | 2 | 3 | 3+ |
| TOTAL | 17 | 21 | 26 | 25+ |
```

### Micro-critique format (5 minutes max)
For quick Slack/PR feedback when a full critique is overkill.
```
Quick look at [page/component]:
+ [1 thing that works]
- [1 most important issue]: [observation]. Try [prescription].
? [1 question about intent]: is [specific element] meant to [specific function]?
```
