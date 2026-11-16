# Team brief: Kept (12:30, Oct 31)

## What the product is

Kept elevates the everyday subagent run. The ordinary habit is to spawn a helper, trust what it says, and start over when it is wrong. Kept keeps the one true line (a passing test, a corrected fact, a lesson) so the next run starts higher. Same model, same tests, less waste.

| Ordinary habit | What Kept keeps | How it works |
| --- | --- | --- |
| A helper's false claim stays in context, and the run starts over | **The passing test** | Every claim is checked: "tests pass" claims against a real pytest run (ground truth), instructions and facts by Jev, a typed yes/no model costing about $0.00002 per check, with unsure cases escalated to an LLM judge. A caught agent is retired, and a replacement starts on probation. |
| A false note spreads, or the next agent inherits failed reasoning | **The corrected fact** | The replacement gets only work that passed tests, never the failed reasoning. Shared notes whose code later fails are revoked from the vector store, and every agent that used them is told. |
| One mistake teaches nobody, so the next run starts from zero | **The lesson** | Each failure becomes a case file saved in a durable actor. It goes over Agent Relay to agents doing related work, who discuss it in a capped thread (the caucus). The lesson enters every later prompt, so the fleet stops hitting that trap. |
| The next run re-derives the same work and pays an LLM judge on every step | **Less waste** | Notes behind code that passed tests are shared and reused instead of regenerated. Oversight goes through cheap Jev checks, not an LLM on every step. Every token is counted from the API's own usage fields, overhead included. |

All state (fleet roster, agents, case library, reasoning store, ledger) lives in **Durable Actors**, so `kill -9` loses nothing. Agents talk over **Agent Relay**.

## How to pitch it (full script: docs/PITCH.md)

- **One line:** "Kept keeps the one true line, so the next run starts higher."
- **Demo:** open on **1,000 live agents** (250 teams) writing real code. Poison 5% of them (lies, bad instructions, false facts), then watch the agent killer catch them, vector cleansing drop the poisoned context, the caucus spread the lessons while the trap-hit rate falls, and token savings tick up. Then `kill -9` and everything comes back. Close on the benchmark: real Codex subagents on the same model and tasks, including a **poisoning head-to-head**.
- **Sponsors:** Durable Actors holds all state (crash test, and 10,000 agents across 20 actors with 0 lost). Agent Relay carries case files, caucus threads, and Jev-checked messages, so a possessed agent can't talk the others out of the spec.
- **Rule:** every number on screen is measured. Anything not measured is cut, not guessed.

## Measured so far

- **Core loop on real infrastructure** (actors, Relay, Jev, DeepSeek): 4/4 functions in 32 s for $0.009; Possess caught and recovered in 22 s; bad instruction blocked at p=0.98; kill -9 → resumed 4/4; ledger rows = totals. 211 tests pass from a fresh clone.
- **Jev:** 222 real calls, 100% correct on the checks it decided, p50 178 ms, $0.0000183 per call.
- **Swarm:** 10,000 agents / 20 actors / 100,000 changes / 0 lost / 2,963 changes per s.
- **Codex baseline (v2 tasks, GPT-6 Luna):** 9/9 pass, $0.0172 and 852k tokens per task; traps caught its agents 5 times mid-run.
- **Ours vs Codex (v2, 3 tasks × 3 trials each):** 9/9 vs 9/9; 53.1k vs 852k tokens and $0.00591 vs $0.0172 per passing task (2.9× cheaper); trap hits 0 vs 5; ours about 5 s slower (61.7 vs 56.7 s). The savings come from the architecture (one-function agents, small clean contexts, cheap Jev checks): the ablation with sharing off was not more expensive, and warm showed no gain. Source: bench/results.summary.json.
- **Poisoning head-to-head (3 tasks × 3 trials per side, 18 real runs):** the false fact and the bad instruction were blocked by Jev before delivery every time they fired on our side; Codex's agents read them and pushed back. The false-commit poison was followed by Codex in 9/9 runs and fixed later; ours caught and retired the agent in 8/8 runs where it fired. No poison survived in final code on either side. Per run, Codex vs ours: invoice $0.0211 / 1.05M tokens vs $0.0097 / 85k; shipping $0.0231 / 1.18M vs $0.0058 / 76k; discount $0.0199 / 0.96M vs $0.0054 / 72k. Source: docs/BENCHMARK.md.
- **Fleet mode, 20 real agents:** 3/3 poisoned agents caught, 0 spread, 5/5 teams passing, $0.032, 65 s (in-memory shards, in-process bus). Source: docs/FLEET.md.
- **Not claimed:** the drift detector (caught 1 of 4 planted traps); token savings from shared reasoning (ablation shows none on v2); a falling trap-hit curve (emergence run so far: 0 trap hits in either arm).

## Done (on `avneh/backend`, merged with `amar/dashboard`)

- **Backend:** actors, model adapters, Jev, Relay, the core loop with 17 review fixes, and the live server (`serve-live`).
- **Benchmark:** v1, v2 (and v3 in progress) task suites, Codex runner, emergence harness, aggregator.
- **For the dashboard:** the contract (types-only) with fleet, feature and timer events, plus the 4-agent and 1,000-agent mocks covering all four features.
- **Demo and docs:** demo driver (8 beats), preflight, start/stop/crash-test scripts, the end-to-end suite, README, sponsor write-up, pitch.

## In progress (agents running)

1. **Live end-to-end runbook ×2** on the real stack (the spec's definition of done).
2. **Fleet mode:** the real 1,000-agent runner with sharded state, shared limits, fleet-wide caucus and poisoning.
3. **Capacity probes:** how many simultaneous model calls and pytest runs the laptop can sustain for 1,000 live agents.
4. **v3 heavy task suite** (long specs, 6–8 functions) plus Codex v3 runs, reported alongside v2.
5. **Poisoning head-to-head:** identical poison injected into Codex and ours.

## Still to do

1. Wire fleet mode into the service, then real runs at 20, 100 and 1,000 agents. **Record the 1,000-agent run as the REPLAY backup.**
2. Our benchmark (cold, warm, ablation) against Codex v2 and v3, plus the poisoning runs on our side.
3. Fill the remaining TBDs in the pitch and write-up (recovery median, trap-hit curve, v3 ours, 1,000-agent run) as those runs land.
4. Dashboard (Amar): the 1,000-dot grid, the four feature panels, the poisoning slide, the benchmark chart.
5. Sponsor-depth upgrades, depending on what the reps say.
6. Rehearse twice with the demo driver, record the backup video, open a PR into `main`.

## How to speed it up

- **Avneh:** get the sponsor reps' answers (what they judge on, hosted or local, a feature they'd love to see) and the judging time and format. Keep the laptop plugged in with Brave closed (the 1,000-agent run needs about 6 GB free).
- **Amar:** pull `avneh/backend` and build the 1,000-dot grid and feature panels on the fleet mock now (`POST /api/runs {"taskId":"invoice_parser","mode":"ours","agents":1000,"poisonRate":0.05}` on `serve-live --mock`). The UI switches to live with no changes once fleet mode lands.
- **Both:** rehearse the pitch out loud on the mock today, leaving the TBDs blank. Don't wait for the numbers.
