# Kept live dashboard: design system

**Kept. Elevate the ordinary.** The live dashboard at `/live` is one screen on a 1920x1080 projector (and a
1440x900 laptop), read from the back of the room by people who have never seen the product. One sentence
carries it: **The ordinary run, kept.** Everything on the Team view serves that sentence.

The spec is the owner-approved mockups in `design/mockups/` (04 Team, 05 Fleet, 06 Details, 07 card states,
08 icons). Copy the look, never the invented content: names, numbers, times and lines on screen come from
the data layer (`src/data`) through the components, never from the images.

## The look

- **Paper.** Warm cream page (`--canvas` #efebe3) with a static, fixed grain layer (an SVG noise multiplied
  in at low opacity; dashboard only, never moves). Cards are a lighter sheet (`--surface` #f6f3ed),
  near-square 5px corners, a very soft lift (`--shadow-card`). No borders on cards; hairlines only to divide.
- **Ink.** #1c1a17 for everything that matters; `--ink-2` 7:1 and `--ink-3` 4.8:1 on the paper.
- **Two colours, one job each.** Orange (`--pathogen` #e0711f; `--pathogen-ink` #b8541a for small text)
  only for a bad note or a caught agent: the Bad note word, the slip of paper, "Really: 2 failed", a
  blocked message, the case-file agent name, the verdict. Print blue (`--accent` #2f5bd3) only for
  a kept lesson: Kept words and chips, the immunity lines, the lesson, kept team rings and ripples, the
  falling trap-hit line. Everything else is ink. Status words are ink (Trusted, Caught, On probation),
  grey and struck through once gone (Retired).
- **Type.** Display: **Imbue** (the landing's face, loaded by `landing/fonts.ts` and `index.html`), an
  extra-condensed high-contrast Didone with an optical-size axis; at display sizes (opsz 100, weight
  600-700) it matches the mockups' tall condensed serif, and sharing it with the landing makes the two
  routes one product. Used for the headline, card names, status words, section titles and big numbers.
  Text: **Albert Sans** (the landing's text face) for everything read at size. Code and function names:
  Geist Mono. Labels are sentence case everywhere (no uppercase, letter-spaced micro-labels).
- **Scale.** The root font follows the viewport (20px at 1920x1080, 16px at 1440x900), so the one-screen
  layout keeps its proportions; nothing on screen is under 14px.

## Views (App.tsx)

| View | Mockup | What is on it |
| --- | --- | --- |
| Team (default at `/live`; `?view=team\|fleet\|details` opens that view and tab switches keep it in the URL) | 04 + 07 | Masthead; headline "The ordinary run, kept." with the proof line (`HeaderProof`: benchmark ratio when measured, else this run); four agent cards 2x2 with the immunity lines in the gutters; lesson + Bad note under them; a vertical rule; "What just happened" (newest first) over this run's numbers (recovery, functions done, spent). Never scrolls at >= 1100px. On a fleet run (more than 4 agents) the stage shows one team of four: the team where a lie was most recently caught, pinned at least 15 s once it has a catch on show (a "Next caught team" button moves it sooner; the change is a 200 ms fade), with a "See the whole fleet" link. The timeline, lesson, immunity lines and the recovery clock follow that team; functions and spend are labelled "Fleet functions" and "Fleet spend". The header counts caught agents from the same snapshot that turns a card Caught. |
| Fleet (auto for runs > 4 agents) | 05 | The fleet sheet (`topology/FleetGrid`: one ink dot per agent, teams of 4 loosely scattered, a slip of paper for a bad note or a caught agent, a blue ring around a team its lesson reached, faint concentric rings around the three newest lesson sources) with a caption + legend strip; three stat cards: Poison caught, Trap hits (with the blue falling line), Cost. Never scrolls. |
| Details | 06 | Case file (title "Case file: Agent 4 (v1)", meta row, Claim, Evidence with numbered pytest output, Verdict, Lesson in display serif, recipients) beside the message feed (a dotted timeline, blocked rows struck through with a BLOCKED tag) and Token usage (Worker / Overhead / Total in display serif, then the ledger). Below: the live graph, benchmark, vector cleansing, swarm, crash test. Scrolls. |

Masthead (all views): wordmark "Kept" in Imbue + "Elevate the ordinary", the one-state pill
(Live / Reconnecting / Mock data / Recording), the run in caps (mode, task or agent count, clock), the three
view tabs centred with an ink rule on the active one, run controls and the theme toggle on the right. What
is happening right now (`StatusSentence`) is announced to screen readers.

## Agent card (AgentStage.tsx)

Name in Imbue with its version ("Agent 4 (v1)") / hairline / the status hero: a 08-style icon and the status
word in Imbue, one fixed size for every state / what it is doing (or the evidence) / a footer of Function,
Step (Checks on probation) and Spent, dropped on bad-note and caught cards so the evidence has room.

| State | Icon | Word | Card |
| --- | --- | --- | --- |
| possessed | note (`icons.tsx`) | Bad note, slip of paper | orange edge + faint wash, "A false rule was left..." |
| retired / retiring | struck bust | Retired (struck) / Retiring, grey | quieter sheet |
| failed | octagon-x | Failed, orange | |
| caught | search | Caught | Said (its last message before the catch) / Really (the pytest summary once the case file carries it, else the checker's reason at the catch; later reasons never replace it, and it stays through Retired and the v2 card) / Told (struck, up to 3 lines) / Blocked by Jev |
| probation | hourglass | On probation | only a replacement (v2 or later) until two checks pass; a first-generation agent marked probation reads Trusted, and the Fleet legend counts only replacements |
| immune | shield-check, blue | Kept, blue, "lesson from Agent 4" | |
| passed probation | shield-check | Passed probation | |
| trusted | shield-check | Trusted | |

**Catch beat (display-side dwell).** Each card plays its states in order and holds Bad note at least 0.8 s,
Caught 1.5 s and Retired 1 s; a state with no hold is skipped when a newer one is waiting. On the mock run
Caught shows at +3.1 s, Retired at +6.0 s and the v2 card at +7.0 s (Caught to v2: 3.9 s). The data is never
changed; the card only catches up with it.

## Icons (08)

lucide-react, stroke 2, sized in em: shield-check (trusted), search (caught), hourglass (probation),
message-square-x (blocked), network (status chatter), send (lesson sent), undo-2 (revoked). Drawn on
lucide's grid in `components/icons.tsx`: Note (the bad note),
ShieldFilled (kept chip), Retired (struck bust), TestTubeCheck (tests pass), Splat, FourDots. Timeline
icons sit in a 2.7rem paper disc (`bg-raised`), coloured only for orange/blue events.

## Motion

Purposeful, short, never ambient. Strong ease-out `--ease-out: cubic-bezier(0.23, 1, 0.32, 1)`; transform
and opacity only (plus stroke-dashoffset for the line); nothing over 400 ms, no loops, no stagger, no
entrance on first paint, no scroll-jacking. Reduced motion turns every move into a short fade or nothing.

| What | Trigger | Property | Duration |
| --- | --- | --- | --- |
| Press | pointer-down on any button | transform scale(0.97) | 120 ms |
| Hover / tab colour | hover | colour, background | 150 ms |
| Status change | card state changes (not first paint) | cross-fade: old word out, new word in, opacity only | 200 ms |
| Card body swap | same | opacity | 200 ms |
| Card edge (possessed / caught) | same | opacity of an inset ring layer | 220 ms |
| Immunity line | a lesson lands | stroke-dashoffset | 380 ms, once |
| Line end dot, ripple | same | opacity + scale | 180 ms at 260 ms; ripple 400 ms at 280 ms, once |
| New "What just happened" line | a new event | opacity, top slot only | 150 ms |
| New message in the feed (Details) | a new message | opacity, top slot only | 150 ms |
| Error note, pause bar | an action fails / hover | opacity + translateY | 200 ms |
| Fleet dot changes state | grid tick | colour / position / scale on canvas | 240 ms |
| Fleet team ring, ripple | a lesson | arc sweep / expanding ring | 380 / 400 ms, once |
| Live graph (Details) | events | pulses 400 ms, packets 260-400 ms, ghost 300 ms, springs 0.3 s critically damped | |

**Micro-interactions** (hover only on `(hover: hover) and (pointer: fine)`; the same answer on `:focus-visible`;
reduced motion keeps colour and shadow, drops movement):

| Where | Hover / focus | Press |
| --- | --- | --- |
| Agent card (focusable) | lifts 2 px, deeper paper shadow (170 ms) | 0.99 |
| Card status icon | shield tick redraws (240 ms), hourglass tips 15 degrees (220 ms), the note tilts plus/minus 3 degrees once (240 ms), magnifier leans | |
| Kept card, caught card or lesson line | immunity lines get a soft halo, every kept card shows its blue edge, chips get a blue ring (180 ms) | |
| "What just happened" row (focusable) | paper tint; its agent's card gets an ink outline (cross-highlight) | |
| View tabs | the ink rule slides to the pointed tab (transform, 200 ms) and back | |
| Buttons (`.press`) | rise 1 px (120 ms); Bad note casts a deeper shadow and leans up to 4 px toward the pointer (the only magnetic element) | 0.97 |
| Stat numbers (run numbers, Fleet cards, token usage) | roll 200 ms on change (old up and out, new up and in, one grid cell) | |
| Fleet dot team | grows 1.15x (150 ms) with a tooltip: "Team 23 · 1 caught · kept" | |
| Details feed row, case-file section | soft paper tint (spread shadow, no padding change) | |

**No layout shift.** The page stays invisible until the display faces and the first snapshot are in (or
2.5 s), then appears at its final size. Fixed-height slots: the proof line, the run numbers' note and steps,
the lesson / Bad note row (success needs no toast: the bad-note card says it; a failure floats above the
button), the timeline (fixed slots keyed by position: a new line fades into the top slot, the others take
the next slot's content in place) and the Details feed (same, plus inserts batched every 2 s). The Fleet
chunk is warmed while idle and settled dots are stamped from a sprite, so switching to Fleet stays in frame.

## Words

- Customer words on the stage: agent, bad note, caught, tests failed, retired, replaced, lesson, kept, cost.
- One naming system everywhere: "Agent 89 (v1)" (`names.ts` also reads fleet ids like `t22w0-g1-...` and case
  ids like `mockfleet01.583.g1`). Verdict line: "Tests: 1 failed. Jev: 88% likely it conflicts with the spec." then
  "(Asked Jev: is this note consistent with the spec?)".
- Jev's state has one source (health): the header's "Jev offline, using fallback" and the ledger's Jev row agree.
- Never on the stage: `w0-g1-mock01`, slot, g1, chunk. Use `components/names.ts`: `agentLabel`, `speaker`,
  `humanize`, `categoryWords`, `testVerdict`.
- One spend figure everywhere (`useSpentUsd`), one recovery figure (`recoveryMs`: fault to tests pass), the
  stale-fault guard in `facts.ts` / `names.ts`. Estimated numbers keep their "est." label.
- Never show a mock benchmark number; the header proof shows the ratio only from measured rows.

## Files

`src/index.css` (tokens, grain, card, motion, layout grids), `components/TopBar.tsx` (masthead),
`App.tsx` (views), `components/AgentStage.tsx` (cards, immunity lines, lesson + Bad note),
`components/Timeline.tsx`, `components/Proof.tsx` (proof line, run numbers), `components/Controls.tsx`,
`components/FleetView.tsx` + `components/topology/FleetGrid.tsx` / `fleetEngine.ts`,
`components/CaseViewer.tsx` + `case/CaseSections.tsx`, `components/RelayFeed.tsx` + `relay/RelayRow.tsx`,
`components/LedgerPanel.tsx`, `components/Cleansing.tsx`, `components/icons.tsx`, `components/ui/*`.
