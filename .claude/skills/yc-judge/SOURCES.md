# yc-judge sources

Researched Oct 31 2026. "Primary" = the author's own writing; "secondary" = summaries or third-party analysis,
used only where a primary source could not be fetched. Each line says which rubric rule it backs.

## YC partners and YC writing

- Kevin Hale, "How to Design a Better Pitch Deck", YC blog, 2015 (primary).
  https://www.ycombinator.com/blog/how-to-design-a-better-pitch-deck
  Legible / simple / obvious. Back row of a 500-seat room must read every slide; large bold type, strong
  contrast, key text near the top; one idea per slide; understood at a glance; stranger test ("if they don't
  immediately say your idea, you lose"); state the conclusion as a headline instead of making people study a
  graph; avoid complex diagrams, too much text, caveats, heavy branding, animations; Hick's law.
  -> 5-second clarity, hierarchy, projector readiness, "state the conclusion" for the hero proof.
- Paul Graham, "How to Present to Investors", 2006-2010 (primary). https://paulgraham.com/investors.html
  Say what you do in the first sentence; get to the demo fast; narrow and specific beats vague; one person talks
  while another drives; a few specific numbers about your own traction; concrete stories; a memorable phrase;
  assume the network will die (have a local backup).
  -> clarity, proof, memorability, demo-readiness.
- Geoff Ralston, "A Guide to Demo Day Presentations", YC blog, 2016 (primary).
  https://www.ycombinator.com/blog/guide-to-demo-day-pitches/
  Open with what you do in words the audience already knows; only show data you can back up (exaggeration is
  fatal); no cumulative always-up graphs; 3-4 takeaways max; ~7 words per slide, large fonts, high contrast,
  important text at the top; avoid complex graphs; live demos often fail, plan for it.
  -> proof & credibility, hierarchy, projector readiness.
- Michael Seibel, "How to Pitch Your Company" (YC Startup Library / Startup School talk; secondary summaries,
  the library page could not be fetched): two-sentence test anyone can understand; lead with the most
  impressive thing; clarity over polish.
  https://torstensson.com/2024/02/12/how-to-pitch-a-seed-stage-startup-according-to-y-combinators-michael-seibel/
  https://www.saastr.com/the-y-combinator-guide-to-perfectly-pitching-your-seed-stage-startup-with-michael-seibel
  -> 5-second clarity, "lead with the hero proof".
- Garry Tan, "friend iteration method" and inverted-pyramid advice (secondary): a listener should be able to recap
  the pitch in 5-8 sentences; put the conclusion first, then proof; plain language over buzzwords.
  https://personal-site-ds4.pages.dev/the-friend-iteration-method-for-pitch-decks-and-yc-apps
  -> memorability ("repeatable sentence"), proof ordering.
- YC, "How to Apply" (primary): a simple one-sentence description that conveys only half your potential is
  still good. https://www.ycombinator.com/howtoapply.html  -> clarity over completeness.

## Demo craft

- Jason Calacanis, "How To Demo Your Startup (Part Two)", TechCrunch 2008 (primary).
  https://techcrunch.com/2008/09/01/how-to-demo-your-startup-part-two/
  Show, don't tell (let the product do the work, don't narrate every click); one driver one navigator; plan for
  glitches; have 10/6/3-word descriptions and repeat the slogan.  -> aha visible without narration, memorability.

## Hackathon judging

- "What judges actually score: notes from a year of hackathon judging", DEV (judge's first-hand notes).
  https://dev.to/kurbaitaev/what-judges-actually-score-notes-from-a-year-of-hackathon-judging-3p4l
  Live end-to-end demo is the biggest differentiator (removes doubt); say what it is in the first sentence;
  narrow and done beats sprawling; the "sentence a judge repeats to another judge" test; polish beyond
  legibility did not raise scores and can make judges wonder where the backend went; keep a 60 s backup recording.
  -> memorability, demo-readiness, "craft is capped by clarity".
- "What I learned after reviewing many AI and developer projects as a hackathon judge", DEV (first-hand).
  https://dev.to/amising6/what-i-learned-after-reviewing-many-ai-and-developer-projects-as-a-hackathon-judge-2g06
  Before/after clarity; evidence (working demo, tests, documented limits) over promises; attractive UI with thin
  depth held projects back.  -> proof & credibility.
- JetBrains, "How to win a hackathon: notes from the judging table", 2026 (403 on fetch; search snippet only):
  a strong project with a confusing demo loses to a simpler one the judges understand.
  https://blog.jetbrains.com/ai/2026/06/how-to-win-a-hackathon-notes-from-the-judging-table/
- Typical rubric shapes (technical, design/UX, impact, idea/creativity, presentation; equal or 40/20/30/10):
  MLH standard rules (four equally weighted criteria) https://github.com/MLH/mlh-policies/blob/main/standard-hackathon-rules.md ;
  Global Travel Hackathon weights https://github.com/Global-Travel-Hackathon/Evaluation-Criteria ;
  Okta hackathon criteria https://devforum.okta.com/t/what-are-the-judging-criteria-for-the-hackathon/15842 ;
  MLH "How to judge a hackathon" https://news.mlh.io/how-to-judge-a-hackathon-finding-the-chosen-one-05-15-2014
  -> weighting; no Haunted Hacks rubric was published online, so the rubric blends YC clarity with the common
  hackathon criteria.

## Dashboard and product design

- Stephen Few, "Dashboard Confusion" (2004) and Information Dashboard Design (2006): a dashboard is the most
  important information on a single screen, monitored at a glance; no scrolling.
  https://www.informationweek.com/data-management/dashboard-confusion
  https://uxmatters.com/mt/archives/2007/04/book-review-information-dashboard-design.php
  -> 5-second glance, no-scroll hard fail, hierarchy.
- Five-second test (Christine Perfetti's method): show a screen for 5 s, ask what it was about.
  https://smashingmagazine.com/2023/12/five-second-testing-case-study  -> the 5-second transcript procedure.
- Linear, "Behind the latest design refresh" (primary, 2026) and "How we redesigned the Linear UI" (2024).
  https://linear.app/now/behind-the-latest-design-refresh  https://linear.app/blog/how-we-redesigned-the-linear-ui
  Chrome quieter than content; not every element carries equal weight; fewer separators ("structure should be
  felt, not seen"); icons only where they aid recognition.  -> hierarchy, craft, slop (icon-in-every-title).
- Vercel Web Interface Guidelines (primary).
  https://vercel.com/design/guidelines  https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md
  Tabular numbers, no broken empty states, specific labels, errors that say the fix.  -> craft.
- Stripe dashboard analyses (secondary; Stripe has no public design write-up on this): key metrics first with a
  comparison, clarity over cleverness. https://www.925studios.co/blog/stripe-dashboard-design-breakdown
  https://blakecrosley.com/guides/design/stripe  -> one hero number with unit + comparison.

## AI-slop tells

- impeccable.style slop catalogue (primary for the list). https://impeccable.style/slop
  Cyan-on-dark and neon accents, glows/halos, glassmorphism, gradient text, identical card grids, nested cards,
  pulsing dots, uppercase micro-labels, default Inter with a flat scale, reflexive cream/beige, hero-metric
  layouts, generic marketing claims.  -> criterion 6. Note it lists cream palettes and hero-number layouts as
  tells: cream is fine only with its own identity, and a hero number is fine only when it is THE proof metric
  with a unit, comparison and source.
- "Why your AI keeps building the same purple gradient website".
  https://prg.sh/ramblings/Why-Your-AI-Keeps-Building-the-Same-Purple-Gradient-Website
- Built In, "AI makes bad design look good enough". https://builtin.com/articles/ai-design-slop-era
