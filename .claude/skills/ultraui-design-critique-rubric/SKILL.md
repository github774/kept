---
name: design-critique-rubric
description: "Use when critiquing a UI design or interface: structured evaluation of hierarchy, contrast, rhythm, alignment, density, motion, and copy, with scoring bands and actionable feedback format."
---

# Design Critique Rubric

## When to use this
- You are reviewing a UI design (screenshot, prototype, or live site) and need structured, actionable feedback.
- You need to separate "I do not like this" from "this has a specific problem with hierarchy/contrast/rhythm."
- You want a consistent scoring method to compare designs or track improvement across iterations.
- You are writing critique feedback for another designer or a design review meeting.
- Do NOT use this when you are specifically auditing for AI-generated visual tells; use `anti-ai-slop-audit` instead.

## Mental model
A design critique is not taste. It is observation, diagnosis, and prescription. The observation is what you see ("the headline and subheading are the same size"). The diagnosis is what is wrong ("there is no hierarchy between them"). The prescription is what to change ("make the headline 2x the subheading size, or differentiate by weight").

The order you look at things matters. Start with the largest structural issues (hierarchy, layout) and work down to the smallest (spacing, motion). Fixing a small detail while the hierarchy is broken wastes effort because the hierarchy fix will change the small detail anyway.

Seven dimensions, evaluated in this order:

1. **Hierarchy** -- Can you tell what is most important in 2 seconds? If not, nothing else matters until this is fixed.
2. **Contrast** -- Are the differences between elements strong enough to create clarity? Contrast is not just color; it is size, weight, spacing, and position.
3. **Alignment** -- Do elements sit on a visible or implied grid? Are deviations intentional?
4. **Rhythm** -- Is there a repeating pattern of spacing, sizing, or placement that creates visual consistency?
5. **Density** -- Is the information density appropriate for the content? Too sparse feels empty; too dense feels overwhelming.
6. **Motion** -- Does animation serve a purpose (directing attention, showing relationships) or is it decoration?
7. **Copy** -- Does the text communicate clearly and concisely? Is the writing specific or generic?

Each dimension is scored 1-5. The total (out of 35) gives an overall quality band.

## Setup
No dependencies. This is a manual critique process. Use screenshots or live URLs as input.

For structured output, use the audit template below in a document or code review tool.

## Core API
| Dimension | Score 1 (broken) | Score 3 (adequate) | Score 5 (excellent) |
|---|---|---|---|
| Hierarchy | Cannot identify the primary element | Clear primary, but secondary/tertiary are muddled | Instant read: primary, secondary, tertiary, and actions are all visually ranked |
| Contrast | Elements bleed together; insufficient size/color/weight differences | Key elements are distinguishable but some pairs are too similar | Every element pair has enough contrast to be immediately distinguishable |
| Alignment | Elements appear randomly placed; no grid visible | Most elements align to an implied grid; 1-2 are off | Every element sits on a deliberate grid; any deviations are clearly intentional |
| Rhythm | No repeating spacing or sizing pattern | Spacing is mostly consistent with occasional inconsistencies | Spacing follows a mathematical scale; vertical rhythm is maintained throughout |
| Density | Large empty areas with no purpose OR walls of text/elements | Density is reasonable but a few areas feel sparse or cramped | Every area's density matches its content importance; breathing room is intentional |
| Motion | Gratuitous animation; things move because they can | Animation exists but does not distract; some is purposeless | Every animation directs attention or communicates state change; nothing decorative |
| Copy | Generic or meaningless text; reads like placeholder | Communicates the point but is wordy or could be more specific | Every word earns its place; specific, concise, and in the product's voice |

## Recipes

### 1. Full critique template
A complete critique document for one page/screen.
```
DESIGN CRITIQUE
===============
Subject: [page name / screen / component]
Reviewer: [name]
Date: [YYYY-MM-DD]
Context: [what is this for? who is the user?]

1. HIERARCHY (score: _/5)
   Observation:
   Diagnosis:
   Prescription:

2. CONTRAST (score: _/5)
   Observation:
   Diagnosis:
   Prescription:

3. ALIGNMENT (score: _/5)
   Observation:
   Diagnosis:
   Prescription:

4. RHYTHM (score: _/5)
   Observation:
   Diagnosis:
   Prescription:

5. DENSITY (score: _/5)
   Observation:
   Diagnosis:
   Prescription:

6. MOTION (score: _/5)
   Observation:
   Diagnosis:
   Prescription:

7. COPY (score: _/5)
   Observation:
   Diagnosis:
   Prescription:

TOTAL: _/35

TOP 3 FIXES (in priority order):
1.
2.
3.

WHAT WORKS WELL:
-
-
```

### 2. Quick hierarchy test (2-second scan)
Evaluate hierarchy by forcing a time limit.
```
HIERARCHY TEST
1. Look at the screen for exactly 2 seconds, then look away.
2. Write down the first 3 things you noticed, in order.
3. Compare your list to the designer's intended priority:
   - Intended #1: [what should be most prominent]
   - Intended #2: [second most prominent]
   - Intended #3: [third most prominent]
4. If your list matches: hierarchy is working.
   If your list does not match: what you noticed first is too loud,
   and what you should have noticed is too quiet.
```

### 3. Contrast audit method
Check size, weight, color, and position contrast between adjacent elements.
```
CONTRAST AUDIT
For each pair of adjacent elements, check 4 contrast types:

| Element A | Element B | Size contrast | Weight contrast | Color contrast | Position contrast | Verdict |
|---|---|---|---|---|---|---|
| Heading | Subheading | 2:1 ratio | Bold vs Regular | Same color | Same x-position | OK: size + weight carry it |
| Subheading | Body text | 1.2:1 ratio | Same weight | Same color | Same x-position | WEAK: only slight size difference |
| Primary CTA | Secondary CTA | Same size | Same weight | Different fill | Side by side | WEAK: need size or weight difference too |

Rule: adjacent elements need contrast on at least 2 of the 4 axes.
If they differ on only 1 axis, the difference looks accidental.
If they differ on 0 axes, they are visually identical and the hierarchy is flat.
```

### 4. Spacing rhythm audit
Check that spacing values follow a consistent scale.
```
SPACING AUDIT
1. Measure (or inspect) every margin and padding value on the page.
2. List all unique values:
   4px, 8px, 12px, 16px, 24px, 32px, 48px, 64px  <-- good: powers-of-2-ish scale
   5px, 10px, 13px, 18px, 22px, 37px, 41px        <-- bad: random values

3. Check for consistent rules:
   - Same spacing between all sibling cards? YES/NO
   - Section spacing larger than element spacing? YES/NO
   - Inline spacing (horizontal) smaller than block spacing (vertical)? YES/NO

4. Check vertical rhythm:
   - Is the body line-height a consistent baseline? (e.g. 24px)
   - Are section headings spaced in multiples of the baseline?
   - Do images snap to baseline multiples?
```

### 5. Density comparison (optimum vs actual)
Compare the page's density to the appropriate target for its content type.
```
DENSITY TARGETS (characters per viewport, approximate)

Content type           | Low density | Optimal    | Too dense
-----------------------|-------------|------------|----------
Landing page (hero)    | 30-80 chars | 80-200     | 200+
Dashboard              | 200-500     | 500-1500   | 1500+
Article / blog post    | 200-400     | 400-800    | 800+
Settings / form        | 100-300     | 300-600    | 600+
E-commerce product     | 150-400     | 400-900    | 900+

Measure: count characters visible in the first viewport (before scroll).
If significantly below the low end: the page feels empty, wasting attention.
If significantly above the high end: the page feels overwhelming, nothing stands out.
```

### 6. Motion purpose audit
Classify every animation on the page by purpose.
```
MOTION AUDIT
For each animation, classify:

| Element | Animation | Purpose | Verdict |
|---|---|---|---|
| Hero heading | Fade in + slide up | Entrance reveal | OK if it is the ONLY element that does this |
| Feature cards | Stagger fade in | Sequential reveal | OK if stagger count is under 8 |
| Button | Scale on hover | Affordance feedback | OK: communicates interactivity |
| Background gradient | Slow rotation | Decoration | REMOVE: adds no information |
| Modal | Backdrop fade + content scale | State change | OK: shows relationship between trigger and modal |
| Logo | Continuous bounce | Attention grab | REMOVE: distracting, adds no information |

Categories:
- Entrance: reveals content that was not visible. OK if varied per element type.
- Feedback: responds to user action. OK if duration is 100-200ms.
- State change: shows a transition between states. OK if it clarifies the relationship.
- Decoration: moves for no reason. Remove it.
- Attention: grabs the eye. OK only for alerts/errors, never for branding.
```

### 7. Copy quality audit
Evaluate the specificity and economy of text.
```
COPY AUDIT
For each text element, rate specificity (1-5) and economy (1-5).

| Text | Specificity | Economy | Rewrite |
|---|---|---|---|
| "Unlock the power of AI" | 1 (generic) | 3 (short but empty) | "Detect fraud in 200ms" |
| "Our platform helps teams collaborate more effectively" | 2 (vague benefit) | 2 (wordy) | "Your team ships 40% faster" |
| "Get started today" | 3 (clear action) | 5 (minimal) | OK as-is |
| "We leverage cutting-edge technology" | 1 (meaningless) | 1 (wordy + empty) | Delete entirely |

Rules:
- Replace "leverage" with the specific thing you are doing.
- Replace "cutting-edge" with the specific technology.
- Replace "empower" with the specific capability.
- If you cannot be specific, the product does not have a clear value proposition. That is a product problem, not a copy problem.
```

## Tuning the feel
Critique severity: if the overall score is below 15/35, focus on the top 1-2 issues only. Giving 7 prescriptions to a design that scores 12 is overwhelming and counterproductive. Fix hierarchy first; most other scores improve as a side effect.

Critique tone: never say "I don't like." Always say "this element does/does not [specific function]." The critique should be falsifiable: the designer should be able to implement the prescription and verify whether it improved the specific dimension.

Positive feedback: always include at least 1-2 things that work well. Critique without positive grounding reads as attack, not analysis.

## Performance
Not applicable; this is a design review process.

## Accessibility
Accessibility is not a separate dimension in this rubric because it crosscuts all 7 dimensions. However, during each dimension's audit:
- **Hierarchy**: check that the visual hierarchy matches the DOM heading hierarchy (h1 > h2 > h3).
- **Contrast**: check that color contrast meets WCAG AA (4.5:1 body, 3:1 large text).
- **Alignment**: check that focus order follows the visual layout.
- **Motion**: check that `prefers-reduced-motion` is respected.
- **Copy**: check that button/link text is descriptive ("Download report" not "Click here").

## Anti-slop rules
- Never critique without stating the context (who is the user, what is the goal). A dashboard for power users has different correct density than a landing page for first-time visitors.
- Never give feedback as taste ("I prefer blue"). Give it as function ("the red CTA on a red-tinted hero does not create enough contrast to be immediately visible").
- Never prescribe a specific solution when the diagnosis is enough. "The heading and body are too similar in size" is better than "make the heading 48px" because the designer may have a better solution than yours.
- Never critique more than 3 things at once. Even if 7 things are wrong, fixing 3 will change the other 4. Re-critique after the fixes land.
- Never score motion as 5/5 when there is no motion. The absence of animation is not excellent motion design; it is N/A. Score only what exists.
- Never critique a wireframe on the same dimensions as a polished design. Wireframes get hierarchy, alignment, and density. Color, contrast, and motion are evaluated on high-fidelity mockups.
- Never compare to a specific other product ("this should look more like Stripe"). Compare to the user's needs and the content's requirements.

## Checklist
- [ ] Context stated (user, goal, content type).
- [ ] All 7 dimensions scored with observation, diagnosis, and prescription.
- [ ] Hierarchy tested with the 2-second scan method.
- [ ] Contrast checked on at least 2 axes per adjacent element pair.
- [ ] Spacing values audited for scale consistency.
- [ ] Motion classified by purpose; decoration flagged for removal.
- [ ] Copy audited for specificity; generic phrases flagged with rewrites.
- [ ] Top 3 fixes prioritized (structural before cosmetic).
- [ ] At least 1 positive observation included.
- [ ] Accessibility cross-checked within each dimension.
