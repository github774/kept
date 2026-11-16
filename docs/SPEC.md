# Kept — Spec

Oct 30, 2026 · @Avneh Bhatia

## Overview

Kept is a runtime for agent fleets that spends fewer tokens and repeats fewer mistakes than standard subagent setups. Agents reuse each other's verified reasoning instead of re-deriving it, and an immune system catches, retires and learns from failing agents.

We are building it at Haunted Hacks (Oct 31, 2026) on Durable Actors (Terse) and Agent Relay. Jev (TypeSafe AI) is the low-cost checker, and OpenAI models do the work, with Jev reached through OpenRouter.

**Pitch:** Other tools tell you your agents failed. We make sure they never fail the same way twice, and spend less doing it.

Implementation details for the build, written for a coding agent: Build spec

## Problem

Standard subagent setups, like the ones in Claude Code and Codex, lose tokens and reliability in four ways.

- **Duplicated reasoning:** subagents on related tasks each work through the same steps on their own. Generated reasoning is the most expensive kind of token.
- **Context poisoning:** when an agent goes wrong, the orchestrator corrects it in the same context. The bad reasoning stays and is re-sent on every turn.
- **No memory of failure:** one agent's mistake does nothing to protect the others, in this run or the next.
- **Expensive oversight:** an LLM judge on every step can roughly double the bill, so most teams skip checking.

## Targets

These are targets, not results. The 2:30 benchmark replaces each with a measured number before anything goes on a slide.

| Metric | Standard setup | Our target | Proven by |
| --- | --- | --- | --- |
| Net token cost | Baseline (100%) | About 40% lower | Benchmark net cost, our overhead included |
| Time to recovery | Orchestrator fixes the agent in its own context | Under 1 minute | Time from fault injection to passing tests |
| Repeat failures | The same mistake recurs across agents | Near zero after the first case file | Benchmark repeat-failure count |
| Oversight cost | An LLM judge on every step | Under 5% of total spend | Ledger overhead line |

Any fleet-scale figure, such as dollars saved per day for 1,000 agents, is computed from the measured cost per task, not estimated.

## Features

Six features work together: two cut tokens directly, three stop failures from spreading, and one measures the savings.

| Feature | What it does | What it saves | Built on |
| --- | --- | --- | --- |
| Shared verified reasoning | While agents work, finished reasoning chunks are checked, embedded and stored. Agents on related tasks retrieve them into context and skip re-deriving them. | Generated reasoning tokens, replaced by cheaper, cacheable input tokens | Durable Actor (reasoning store), Jev, embeddings |
| Jev checks and routing | Every claim or action gets a typed yes/no check with a confidence score. Low confidence goes to real tests or an LLM. Jev also picks the cheapest model that can handle each subtask. | Most LLM-judge calls; frontier-model calls on easy subtasks | Jev |
| Early detection | Each agent's recent actions are embedded and compared with past failure paths from the case files. An agent heading toward one is retired before it fails. | Tokens spent on doomed paths | Embeddings, case-file actor |
| Retire and respawn | An agent proven wrong is retired and its failure saved as a case file. A fresh agent gets a clean task summary plus the most relevant lessons. | Re-sending a long, poisoned context every turn | Durable Actors |
| Herd immunity | The case file goes over Agent Relay to agents with similar tasks or personas. They discuss it for a capped number of turns and keep the lesson. | Repeat failures and their retries | Agent Relay |
| Token ledger | Every agent's actor reports tokens spent. A ledger actor totals spending, savings by feature and our own overhead. | Nothing; it proves the savings with a live net-savings counter | Durable Actors |

**Details that matter**

- **Agent status:** Trusted → Under investigation → Retired. A replacement starts on Probation and earns Trusted.
- **Case file:** agent, task, the false claim, the evidence (test output, Jev verdict and confidence, escalation reason), the drift trace, and a one-line lesson.
- **Handoff:** the replacement gets the verified task progress, not the reasoning that led to the failure. Deciding what carries over is the core design problem.
- **Prompt cache:** lessons go into a fixed prefix shared by respawned agents, so retiring an agent does not throw away the cache.
- **Jev limits:** it is weaker on code and math, so code claims are checked by running tests. Jev returns a number, not a reason; the case file's reason comes from the evidence.

## Architecture

&#91;embedded content: core loop · 6 components\]

Claims that pass Jev become shared reasoning; failing or drifting agents are retired, and their case file reaches related agents over Agent Relay.

Each piece of state lives in a Durable Actor, so it survives crashes and concurrent updates land in order.

| Actor | Holds |
| --- | --- |
| Agent (one per agent) | Status, verified task progress, tokens spent |
| Case file | Failure evidence, drift trace, one-line lesson |
| Reasoning store | Verified chunks, their embeddings and who reused them |
| Ledger | Tokens spent, savings by feature, our own overhead |

**Jev adapter:** every check goes through one interface. If Jev is down, a small hosted LLM judge swaps in, so the demo never stalls. A local model such as Llama 3 8B also works but needs a GPU and setup time.

## Benchmark

We claim a narrow, measured win: on our task set, higher success at lower net cost than a standard orchestrator-plus-subagents setup.

1. **Same model, same tasks on both sides.** The baseline is real Codex subagents, and both sides run on the same OpenAI model (GPT-6 Luna).
2. **Task set:** 3 Python tasks with tests, so success is objective. Each runs 3 times per side.
3. **Seeded traps:** the same misleading lines and planted note sit in both sides' task materials.
4. **Claim wording:** "On our 3-task benchmark against Codex subagents, X% higher success at Y% lower net cost, with Z% faster recovery." No general "better than Codex" claim.

| Metric | How we measure it |
| --- | --- |
| Task success rate | Tests pass at the end of the run |
| Net cost (USD) | All tokens × price, including our own overhead |
| Time to recovery (s) | Wall clock from fault injection to tests passing again |
| Reasoning tokens skipped | Tokens in reused chunks that agents did not have to generate |
| Repeat failures | The same failure type recurring after its first case file |
| Time to finish (min) | Wall clock from task start to passing tests |

## Demo script

Three minutes, one dashboard: agent statuses, a live Relay message feed and the net-savings counter.

1. **Fleet at work:** agents run a coding task; everyone shows Trusted.
2. **Shared reasoning:** an agent picks up a verified chunk from another. The counter ticks up with the tokens and dollars skipped.
3. **Possession:** we click "Possess an agent." It starts making false claims.
4. **Catch:** Jev flags the claims and the drift score climbs. The agent is retired, its case file appears and a replacement spawns, with a timer showing how long recovery took.
5. **Herd immunity:** a related agent reads the case file over Relay, then avoids the same trap. The ledger shows the repeat-failure count.
6. **Crash test:** kill the server and restart it. Case files, statuses and the ledger are all still there.
7. **Swarm simulator:** run 10,000 simulated agents, one actor each. The dashboard shows the state changes it handled and whether any were lost.
8. **Close:** the benchmark chart, baseline vs. ours, on success rate, time to recovery and net cost.

## Build plan

Hacking runs 11:00 to 4:00 with lunch at 1:00, so the core loop must work by about 2:30. All code is written at the event; planning tonight is allowed.

**Tonight (no code)**

- [ ] Set up Devpost accounts for the team
- [ ] Get Jev early access through DigitalOcean and confirm one test call works
- [ ] Get an OpenAI API key ready for the event credits
- [ ] Read the Durable Actors README and examples, and the Agent Relay docs
- [ ] Write the benchmark task descriptions and fault list as plain text; write the tests at the event

**Event day**

1. **11:00–11:45** Scaffold: Agent, Case file, Reasoning store and Ledger actors; agents on OpenAI; Agent Relay wired up.
2. **11:45–12:30** Retire and respawn, and case files.
3. **12:30–1:00** Jev checks through the adapter, with the fallback judge.
4. **1:00–1:30** Lunch.
5. **1:30–2:00** Herd immunity over Relay.
6. **2:00–2:30** Shared verified reasoning and ledger tracking.
7. **2:30–3:15** Benchmark runs. Done early so the chart has real numbers.
8. **3:15–3:45** Swarm simulator, then early detection if time allows.
9. **3:45–4:00** Devpost submission and final fixes.

**If behind, cut in this order:** early detection, then the swarm simulator, then Jev model routing. Keep shared reasoning and the benchmark; they carry the token-savings claim.

## Risks and open questions

| Risk | Our answer |
| --- | --- |
| A wrong chunk spreads through shared reasoning | Only verified chunks are shared, and each records who reused it. If one later proves wrong, it is revoked and those agents are notified. |
| Who watches the watchers? | Votes are weighted by trust, verdicts need evidence rather than a headcount, and checkers can run on a different model from workers. |
| The majority is wrong | Code claims are checked against tests, not against what other agents believe. |
| Our overhead eats the savings | The ledger counts our own Jev, embedding and Relay costs, and we report net savings only. |
| Retiring agents wipes the prompt cache | Lessons live in a fixed shared prefix that stays cacheable. |
| Jev is early access, and most of its numbers come from TypeSafe | Confirm access tonight. The Jev adapter swaps in a small hosted LLM judge if Jev is down. |
| "50,000 agents" is not shown | Demo 5–10 real agents plus the 10,000-agent swarm simulator, and claim only what the simulator measures. |
| Model labs build this into their own subagents | We work with any model and build a failure library no single lab has. |

**Open questions**

- [ ] Budget: the $100 OpenAI event credits cover everything except Jev, which runs on about $5 of OpenRouter credit.
- [ ] Which Agent Relay SDK is the sponsor's? Several unrelated projects share the name; confirm at check-in.

## Sources

- [Durable Actors (TerseAI on GitHub)](https://github.com/TerseAI/durable-actors)
- [Agent Relay overview (agentcommunity.org)](https://agentcommunity.org/m/agent-relay)
- [What is Jev? (DigitalOcean)](https://www.digitalocean.com/resources/articles/what-is-jev)
- [JEV-as-a-Judge: Accept When Confident, Escalate When Unsure (arXiv)](https://arxiv.org/pdf/2609.26550)
