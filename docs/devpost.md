# Devpost submission draft: Kept

Haunted Hacks, Oct 31 2026. Submissions due 4:00 PM.

Before pasting into Devpost:
- Replace every `[placeholder]` with a number from `bench/results.json` or the dashboard. Never estimate one.
- Delete any sentence marked `[CUT IF NOT SHIPPED]` whose feature did not pass its check at 3:15 PM.
- Delete any line in Challenges or What we learned that did not actually happen to us today.
- If a benchmark clause favors Codex, drop that clause. Do not reword it.

---

## Name

Kept

## Tagline

Elevate the ordinary.

## Inspiration

The ordinary habit is to spawn a helper, trust what it says, and start the whole run over when it is wrong. One subagent says "tests pass" when they don't, and the orchestrator and every other subagent take its word for it. A bad assumption in one agent's context, like a misleading comment in a starter file, gets rediscovered the hard way by every agent that reads it. The passing test, the corrected fact, and the lesson go out with the rest.

Kept keeps that one true line, so the next run starts higher. Same model, same tests, less waste. A "tests pass" claim is settled by running pytest. A teammate message is checked against the spec before it is delivered. The lesson is kept for the agents it applies to. The state survives a kill mid-run.

## What it does

Kept elevates the everyday subagent run. It runs a small fleet of coding agents (4 per run) on one Python task, one function each, and keeps the one true line: a passing test, a corrected fact, a lesson. The next run starts higher.

- **Ground-truth verification.** When an agent claims its tests pass, we run pytest. A false claim gets the agent retired. No model is asked whether another model lied.
- **Checked messages.** Before a teammate's message is delivered, Jev (TypeSafe AI's judge model) checks whether following it would break the spec. Messages that would are blocked and shown struck through on the dashboard. Uncertain calls go to a fallback LLM judge.
- **Retire and respawn.** A caught agent is retired, a case file is written (claim, test output, judge result, failure category, a one-line lesson), and a replacement takes over with only the code that passed its tests. The replacement starts on probation until it proves itself.
- **Kept lesson.** The case file goes over Agent Relay to the teammates it is relevant to (picked by embedding similarity plus a Jev relevance check). They discuss it in one short thread, and the lesson is kept in a shared lessons block in every later prompt.
- **Shared verified reasoning.** When an agent's code passes its tests and its approach note checks out against the spec, that note is shared with teammates working on similar pieces. Only verified notes spread. If code built on a note later fails, the note is revoked and every agent that used it is told.
- **Honest token ledger.** Every API call writes one row from its real usage fields. Overhead (judging, embeddings, lessons, case threads) is counted, and net savings only appear once a real baseline run exists.
- **Crash-proof state.** All state lives in durable actors. You can `kill -9` the actor runtime and the orchestrator mid-run, restart them, and the dashboard comes back with the same statuses, cases and totals while the agents carry on.
- **Bad note.** For the demo, one click leaves a false rule on one working agent. On its next step it claims its tests pass and tries to talk teammates out of the spec. The fault is injected by our orchestrator, not by asking the model to misbehave, so it fires every time.
- **Swarm simulator.** [CUT IF NOT SHIPPED] Simulated agents (no model calls), each backed by a durable actor, to show how the state layer holds up at 100 and 1,000 agents. In our runs it handled [N agents] at [rate] state changes per second with [lost] lost; those are the simulator's measured numbers, nothing more.

**Benchmark.** On our 3-task benchmark against Codex subagents, [X% from bench/results.json] higher success at [Y% from bench/results.json] lower net cost, with [Z% from bench/results.json] faster recovery. That is in our runs: 3 tasks × 3 trials per side, the same model on both sides, overhead included, every trial counted.

## How we built it

Four processes on one laptop, TypeScript throughout, Python for the code the agents write.

- **Durable Actors by Terse** (port 7100, run on Bun) holds all state in five actor classes: Fleet (the roster and the single source of truth for who is active), Agent (one per slot and generation), CaseLibrary, ReasoningStore and Ledger. Anything that grows lives in the actor's SQLite. Actors never call the network or each other. Every write carries the agent's generation, so a late reply from a retired agent is rejected, and the retire protocol is safe to repeat after a crash.
- **Agent Relay** (local server on port 8787) carries all agent-to-agent messaging. Each run gets its own channels (`fleet-<runId>`, `cases-<runId>`), every send has an idempotency key, and each agent generation registers its own identity, which is released the moment it is retired.
- **Jev by TypeSafe AI, via OpenRouter** (`typesafe/jev-1.14`, through the TypeSafe SDK pointed at OpenRouter) answers narrow typed questions: does this instruction conflict with the spec, does this fact contradict it, is this note consistent with it, which failure category is this, is this lesson relevant to this subtask. We act at a problem probability of 0.85 or more, pass under 0.15, and send the middle band to a fallback judge. If Jev fails 3 times in a row, the adapter switches to the fallback for 60 seconds and the dashboard says so.
- **OpenAI GPT-6 Luna** powers the worker agents (strict structured outputs, one action per step), the fallback judge and the lesson writer. Embeddings use `text-embedding-3-small` at 256 dimensions. The prompt puts stable parts first so the prompt cache hits.
- **The orchestrator** (Bun, port 3000) is stateless. It runs the worker loop, the tests (pytest in a temp folder per agent, 10-second timeout), the retire protocol and the Relay bridge, writes the ledger, and serves the dashboard API and an SSE stream. On startup it rebuilds itself from the Fleet actor.
- **The dashboard** is Vite + React. It shows the agent grid, the Relay feed (blocked messages struck through), the case viewer, the ledger and the benchmark chart, and reconnects on its own with backoff after a server dies. Anything mocked or replayed is badged MOCK or REPLAY; any estimate is labeled "est.".
- **The baseline** is real Codex: `codex exec` with one custom worker subagent, on the same GPT-6 Luna model, run in a fresh temp folder with its own OpenAI project and key, so its usage shows up separately on OpenAI's usage page.
- **Hard caps** are always on: 12 steps per agent generation, 2 generations per slot, $1.00 per run, 1 Relay message per agent per step, 3 replies per case thread.

## Challenges we ran into

[Keep only what actually happened today; delete the rest.]

- Keeping the benchmark fair. Codex has no spending cap flag, so both sides got the same 10-minute wall clock, the same tasks, traps, model, price table and "spec wins" rule. The faults we inject live can't be injected into Codex, so they are left out of the head-to-head entirely.
- Counting tokens honestly. Shared reasoning is not free: a reused note is input tokens on the receiving side. The live counter is labeled as an estimate, and the real savings number only comes from the benchmark.
- Making retire safe under a crash. A retire touches the Fleet, the Agent, Relay, the case library and a new agent. Each step had to be safe to repeat so a `kill -9` halfway through resumes cleanly instead of double-retiring.
- Agent Relay's local setup: the SDK client has to be pointed at the local server explicitly, and names are create-only, which is why every name includes the generation and run ID.
- Durable Actors persistence: persisted objects have to be reassigned, not edited in place, or the change is silently lost. The crash test is what catches it.
- [Anything else that bit us today.]

## Accomplishments that we're proud of

[Keep only what passed its check.]

- The crash test: `kill -9` the actor runtime and the orchestrator mid-run, restart, and the dashboard comes back with the same statuses, cases and ledger totals.
- Possession fires every time, and the fleet catches it from ground truth, not from another model's opinion.
- A lesson from one agent's mistake reaching a related agent, which then avoids the same trap.
- A real head-to-head with Codex subagents on the same model, with every trial counted and every number traceable to a run ID or Codex session ID in `bench/results.json`.
- Nothing faked: mocks and replays are badged, estimates say "est.", and net savings stay blank until a real baseline exists.

## What we learned

[Keep only what is true for us.]

- Ground truth beats judgment. Running the tests settles most claims for free; judges are only worth it for questions you can't test.
- Small, typed questions get better answers. Jev did best with one judgment per question, only the spec excerpt it needed, and "true" always meaning "problem found".
- Overhead is real and has to be on the scoreboard, or a "savings" number means nothing.
- Durable state changes how you design an orchestrator: once nothing lives in the process, a crash is just a restart.

## What's next for Kept

- A drift monitor that flags an agent heading toward a known failure before it happens, using case-file embeddings, confirmed by Jev. [Move to What it does only if it shipped, with the hit rate it measured.]
- Routing easy subtasks to a smaller model with Jev's difficulty question.
- More tasks and more trials, so we can say more than "in our runs".
- Running Kept around other agent frameworks, not just our own worker loop.
- A case library that carries across projects, with revocation, so a fleet starts each job from lessons already kept.

## Built with

typescript, bun, node.js, python, pytest, durable-actors, terse, agent-relay, jev, typesafe-ai, openrouter, openai, gpt-6-luna, openai-embeddings, codex-cli, sqlite, server-sent-events, vite, react, tailwindcss, recharts
