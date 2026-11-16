# Pitch: Kept (3 minutes)

Numbers in **bold** are measured and sourced. `[TBD: …]` is filled only from a measured run; if a run doesn't happen, the line gets cut instead of guessed.

---

## 0:00 – Hook (15 s)

> "The ordinary habit is this. Spawn a helper. Trust what it says. Start over when it is wrong.
>
> Kept keeps the one true line. A passing test. A corrected fact. A lesson. The next run starts higher. Same model, same tests, less waste."

## 0:15 – Fleet at scale (20 s) · *demo beat: start 1,000 agents*

> "This is 1,000 live agents, 250 teams, all writing real Python against real tests. Every dot is one agent. Every agent's state lives in its own Durable Actor shard, so nothing here exists only in memory."

## 0:35 – Poison (15 s) · *demo beat: poisoning fires at t≈5 s*

> "A false rule hits 5% of them. Some lie that their tests pass. Some tell their teammates to break the spec. Some get fed false facts. Kept does not start the run over. It keeps the line that is still true."

## 0:50 – Agent killer (25 s) · *red dots → caught → retired → replaced*

> "A false 'tests pass' claim gets checked against the real test run: ground truth, no LLM. Bad instructions get checked by Jev, a typed yes/no model, in about **200 ms** for **$0.00002 a check**. Anything it's unsure about escalates to a real judge.
>
> The false line is dropped. A replacement starts from the work that passed, and from the lesson."

Live numbers to read: poison caught / injected (our 20-agent real run: **3 / 3 caught, 0 spread**), `[TBD: median recovery time]` (measured once so far: **14.4 s**, poisoning head-to-head, ours trial 2; one sample is not a median).

## 1:15 – Vector cleansing (20 s) · *context.cleansed + chunk.revoked*

> "The replacement keeps the work that passed tests, not the false reasoning. If a shared note turns out wrong, we pull it from the vector store and tell every agent that used it."

Cut: "tokens of bad context dropped". Measured in the 20-agent run it was **−304**: the replacements' first prompts (1,321 and 1,389 tokens) were longer than the retired agents' last ones (1,202 and 1,204), because the agents were caught early and the handoff adds the lesson. No note was revoked in that run (the revoke path is covered by a MOCK test only).

## 1:35 – The caucus and learning (30 s) · *case file → thread → trap-hit rate falling*

> "Every failure becomes a case file, saved in a durable actor: the false claim, the evidence, and a one-line lesson. It goes out over Agent Relay to the agents doing related work, who answer in a capped thread. The lesson is kept, and it enters every prompt after that.
>
> Here's the trap-hit rate across the fleet: `[TBD: start rate]` at the beginning, `[TBD: end rate]` now. Same model, same tasks, no retraining. The next run starts from that lesson."

Still TBD: the emergence run so far (64 agents) has **0 trap hits in either arm** (0 of 24 exposed agents each) and no case file, so there is no curve yet. If it stays flat, cut this line and use the v2 trap line in the close instead.

## 2:05 – Token savings (20 s) · *ledger counters*

> "Every token is counted from the API's own usage fields, including ours. The savings come from the architecture: each agent owns one function with a small, clean context, and it's checked by Jev at two thousandths of a cent, not by an LLM judge. Our oversight costs **7.1%** of total spend in our benchmark runs, not double."

Cut: "reasoning reused instead of regenerated". The ablation shows no reuse benefit on v2: with shared notes off it used *fewer* tokens per passing task than cold (44.1k / $0.0052 vs 53.1k / $0.0059, 9 trials each), and warm showed no gain over cold. v3 is pending. So we don't claim a saving from reuse. The live counter (1,433 tokens in the 20-agent run) is labelled "est." and is not a measurement.

## 2:25 – Crash test (20 s) · *kill -9*

> "One more thing. *[kill -9 the runtime]* Dead. *[restart]* Every status, every case file, every ledger row: back. That's Durable Actors. We also pushed **10,000 simulated agents through 20 actors: 100,000 state changes, zero lost.**"

## 2:45 – Close (15 s) · *benchmark slide: reliability first, cost second*

> "Against real Codex subagents, same model, same tasks, same tests. First, **reliability**. On our light suite Codex's subagents fell into our traps **5 times** in 9 runs; ours **0**. On the heavy suite, Codex hit the same trap again and again, **2 to 3 subagents per run**, and spent **92 to 141 seconds** recovering each time; ours hit **0** in 6 runs. Then we poisoned both. A fake 'tests pass' commit: Codex followed it in **9 of 9** runs; we caught the lying agent with a real test run and retired it **every time it fired, 8 of 8**. A false fact and a bad instruction: Codex's agents read them and had to argue them down; ours never saw them, because Jev blocked them before delivery. And we retired **zero** honest agents.
>
> And it's cheaper. Per passing task: **53k tokens vs 852k** and **2.9× less cost** on the light suite; **263k vs 2.14M** and **1.7× less** on the heavy one. Both sides finish every task; we're about 5 seconds slower on the light suite.
>
> Kept keeps the one true line, so the next run starts higher."

Light suite = v2 (3 tasks × 3 trials each side). Heavy suite = v3 (Codex 9 runs, ours 6). Poison = 3 tasks × 3 trials each side (18 runs). Source: docs/BENCHMARK.md, bench/results.summary.json, bench/poison/summary.json.

Not claimed: "faster recovery" (commit poison: ours 14.4 s in the one run where it was followed, Codex 17.5 s mean over 3; too few to compare) and "higher completion" (both 9/9).

---

## Sponsor lines (use if a sponsor judge is at the table)

- **Durable Actors (Terse):** "All fleet state lives in actors: Fleet as the single source of truth, sharded agent state, the case library and the ledger. Retire is an idempotent protocol behind a generation guard, so a `kill -9` mid-retire resumes cleanly. 10,000 agents across 20 actors with 0 lost."
- **Agent Relay:** "Agents coordinate over Relay: per-run channels, a warden identity broadcasting case files to related agents, capped threads, and every teammate message checked by Jev before delivery. An agent with a bad note can't talk the others out of the spec."

## Honest answers for judges' questions

- **"Is the benchmark fair?"** Same model (GPT-6 Luna), same tasks, same tests, same time limit on both sides. We report the light suite (v2) and the reasoning-heavy suite (v3), not just the best one. v3: Codex 9 runs, ours 6 (2 per task); both pass every run.
- **"What didn't work?"** Our drift detector caught only 1 of 4 planted traps in calibration, so we don't claim it.
- **"Isn't Jev weak on code?"** Yes, so code claims are settled by running the tests. Jev only judges text claims, and unsure cases escalate.

## Sources for every bold number

| Claim | Source |
| --- | --- |
| Jev ~200 ms, $0.00002/check | bench/jev-calibration/report.md (p50 178 ms, $0.0000183/call, 222 calls) |
| 10,000 agents / 20 actors / 100,000 changes / 0 lost | docs/DECISIONS.md #13 |
| Codex $0.0172 and 852k tokens per passing task | bench/results.summary.json `codex_baseline@v2` (9/9 trials; mean $0.017219, 852,191 tokens) |
| 3 / 3 poisoned caught, 0 spread (20-agent real run, 5 teams, 5/5 passing, $0.032, 65 s) | docs/FLEET.md "Smoke" |
| −304 tokens of context dropped (cut) | docs/FLEET.md "Smoke", `context.cleansed` |
| 14.4 s recovery (one sample) | docs/BENCHMARK.md "Poisoning head-to-head", ours trial 2 |
| 0 trap hits in either emergence arm so far | bench/emergence/summary.json (experiment emg-202610311936, partial snapshot at 19:47 UTC: 64 agents) |
| Oversight 7.1% of spend | bench/results.json `ours_cold` v2, 9 rows: `tokens_by_category` non-worker USD / total = $0.003770 / $0.053142 = 7.09% (per run 1.8–18.2%) |
| Ablation 44.1k / $0.0052 vs cold 53.1k / $0.0059; warm 56.1k / $0.0063 (reuse claim cut) | bench/results.summary.json `ablation@v2`, `ours_cold@v2`, `ours_warm@v2` (9 trials each) |
| 9/9 vs 9/9; 53.1k vs 852k tokens (93.77% fewer); 2.9× cheaper ($0.005905 vs $0.017219, 65.71% lower); uncached input 14.5k vs 57.7k; output 9.5k vs 7.1k; 61.7 s vs 56.7 s | bench/results.summary.json `ours_cold@v2` vs `codex_baseline@v2`, 3 tasks × 3 trials each (commit 1f5e745) |
| Trap hits on v2: Codex 5 (in 4 of 9 runs, 1 repeat, all fixed before the end), ours 0 in 9 | bench/results.json `trap_hits` (Codex: agents' own pytest output; ours: ground-truth snapshots every ~3 s, which can miss a hit shorter than that) |
| Poisoning: p 0.90–0.96 blocks; Codex commit poison followed 3/3 (repaired in 13.2–21.5 s, silently in 2); ours F1 fired 2/3, retired 2/2; $0.0097 / 85.2k vs $0.021 / 1.048M per run | bench/poison/results.json, bench/poison/summary.json, docs/BENCHMARK.md "Poisoning head-to-head" (invoice_parser, 3 trials per side; exact means $0.009658 / 85,167 vs $0.021080 / 1,048,144) |
