# docs

Start with the first three. WRITEUP.md links each number to the file in this repo that measured it.

| File | What it is | Read it when |
| --- | --- | --- |
| [WRITEUP.md](WRITEUP.md) | The project write-up: problem, what Kept does, how it uses Durable Actors, Agent Relay and Jev, measured results, honest limits. | First. The fastest full picture. |
| [BENCHMARK.md](BENCHMARK.md) | Kept vs real Codex subagents on the same model and tasks: fairness rules, task suites (v1, v2, v3), metric definitions, poisoning head-to-head, feature A/Bs. | You want to check a number or rerun the benchmark. |
| [DECISIONS.md](DECISIONS.md) | Decisions made at the event. They override BUILD_SPEC.md. | Code and BUILD_SPEC.md disagree. |
| [SPEC.md](SPEC.md) | Product spec written the night before: problem, targets, features, architecture, demo script, risks. | You want the original intent. |
| [BUILD_SPEC.md](BUILD_SPEC.md) | Build contract: actors, worker loop, verification, retire/respawn, herd immunity, ledger, prompts. Source comments cite its section names. | You are reading a source file that says "BUILD_SPEC ...". |
| [DATA_CONTRACT.md](DATA_CONTRACT.md) | Orchestrator to dashboard API: REST routes, SSE events, mock service. | You are working on the dashboard or the HTTP API. |
| [FLEET.md](FLEET.md) | Fleet-scale mode (1,000 agents as teams of 4) and its code map. | You are running or reading `orchestrator/src/fleet/`. |
| [SMOKE.md](SMOKE.md) | Real-API smoke results (OpenRouter, Jev, embeddings) and how to rerun them. | You need to confirm the live APIs behave as the code assumes. |
| [demo-runbook.md](demo-runbook.md) | The rehearsed 3-minute stage demo, beat by beat (SAY / DO cues). | Before presenting. |
| [PITCH.md](PITCH.md) | 3-minute pitch script. | Before presenting. |
| [devpost.md](devpost.md) | Devpost submission draft. | You are filling in the submission. |
| [BRIEF.md](BRIEF.md) | Team brief from 12:30 on event day: product, pitch outline, what was measured, done and still to do. | You want the mid-event snapshot. |
| [archive/build-spec.md](archive/build-spec.md) | Raw paste of the build spec. BUILD_SPEC.md is the cleaned copy; this one still has the Processes, Open questions and Sources sections. | Only for history. |

Elsewhere: `README.md` (repo root) for setup, `scripts/README.md` for process control, `bench/*/README.md` for each
benchmark runner, `dashboard/README.md` for the front end, `contract/API.md` for the wire types.
