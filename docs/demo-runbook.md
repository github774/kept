# Demo runbook: Kept (3 minutes)

Presenter: Amar. Backend on call: Avneh (stands by the laptop, watches `/tmp/ss-orch.log`).
One laptop, dashboard full screen, one terminal window with the tabs listed below.

How to read this script:

- **SAY** is what you say out loud. Short lines. Say them slowly; the screen does the work.
- **DO** is what you click or point at.
- **IF IT BREAKS** is the exact line to say and what to do next. Never apologize twice; say the line and move on.
- Anything in `[square brackets]` is a placeholder. Fill it from the screen or from `bench/results.json`. Never say a number you have not read off a real source today.

---

## The one rule

**Any step with no working backend by 3:15 PM gets cut, not faked.**

At 3:15 PM, Amar and Avneh go down the cut card below. If a step does not work live, cross it out of this script and out of the backup video plan, and use the spare seconds to slow down elsewhere. No mock data on stage, no MOCK or REPLAY badge on screen. If the backup video has to be shown, say that it is a recording.

### Cut card (fill in at 3:15 PM)

| Step | Live check | Works? |
| --- | --- | --- |
| 1. Fleet at work | Start run: 4 cards appear and their step counts go up | [ ] |
| 2. Shared reasoning | A verified note shows in the Relay feed and "reasoning reused (est.)" goes above 0 | [ ] |
| 3. Bad note | Bad note on an active slot returns `ok` (not 409) | [ ] |
| 4. Catch | The false claim fails its tests, the message shows struck through, the agent is retired, a case appears, the replacement is on Probation | [ ] |
| 5. Kept lesson | The case viewer lists at least one recipient, with a reply | [ ] |
| 6. Crash test | kill -9 both, banner shows "Reconnecting", restart, same statuses, cases and totals | [ ] |
| 7. Swarm simulator | 100 then 1,000 agents; panel shows agents, state changes, lost, rate | [ ] |
| 8. Benchmark close | Results chart renders from `bench/results.json` with `origin: "live"` | [ ] |

If a step is cut, also cut its line from the 30-second version.

---

## Before going on stage

### Terminal tabs (set up by 3:40 PM)

| Tab | Runs | Notes |
| --- | --- | --- |
| RELAY | `relay init` (Node 22, port 8787) | Never touched on stage |
| DASH | `cd dashboard && VITE_API_URL=http://127.0.0.1:3000 bun run dev` (port 5173) | Never touched on stage |
| STAGE | Starts and kills the actor runtime (7100) and orchestrator (3000) | The only tab you show. Font size large. |
| LOGS | `tail -f /tmp/ss-orch.log` | For Avneh, not for the audience |

Start the actor runtime and orchestrator from the STAGE tab, from the repo root, with the exact same line you will use for the restart on stage. That way the processes are in the background and the kill command finds them:

```bash
(cd actors && nohup bunx durable-actors dev > /tmp/ss-actors.log 2>&1 &); sleep 3; (cd orchestrator && nohup bun run dev > /tmp/ss-orch.log 2>&1 &)
```

The `sleep 3` gives the actor runtime time to listen before the orchestrator reconciles from the Fleet actor. Tune it in rehearsal.

### Checklist (T minus 10 minutes)

- [ ] Versions: `bun -v` is 1.4.2 or newer; in the RELAY tab `node -v` is v22.
- [ ] All four ports are listening:
      `lsof -nP -iTCP:7100 -iTCP:8787 -iTCP:3000 -iTCP:5173 -sTCP:LISTEN`
      You should see exactly one listener on each of 7100, 8787, 3000 and 5173.
- [ ] Health is green: `curl -s http://127.0.0.1:3000/api/health`
      expects `actorsConnected: true`, `relayConnected: true`, `jevOffline: false`.
- [ ] The mock server is stopped (Ctrl-C its tab). The dashboard points at port 3000, not the mock.
- [ ] **No MOCK or REPLAY badge** on the dashboard. If you see one, you are on the mock server or a replay. Fix it before going on.
- [ ] No "Jev offline, using fallback" banner.
- [ ] `curl -s http://127.0.0.1:3000/api/bench/results` returns `origin: "live"` and the rows you expect (9 Codex rows, 9 ours-cold rows). The Results chart renders.
- [ ] The close card is filled in with real numbers from `bench/results.json` (see "Filling in the numbers" at the end). Write them on a sticky note on the laptop bezel.
- [ ] Swarm simulator not running yet (`swarm.running` is false in `/api/snapshot`).
- [ ] Backup video open in its own window, paused at 0:00, volume off. You know the shortcut to switch to it (Cmd-Tab or Cmd-`).
- [ ] Do Not Disturb on. Laptop on power. Browser zoom set so the back row can read the agent cards. Bookmarks bar and other tabs hidden.
- [ ] You know where the kill switch is (Stop button, or `curl -s -X POST http://127.0.0.1:3000/api/run/stop -H 'content-type: application/json' -d '{}'`).

### T minus 60 seconds: start the demo run

Start the run about 1 minute before you start talking, with a fresh, empty case library, so agents are mid-work on stage and a lesson can be kept live.

- [ ] DO: Controls, mode **ours**, task **invoice_parser**, click **Start run**. Or from STAGE:
      `curl -s -X POST http://127.0.0.1:3000/api/run/start -H 'content-type: application/json' -d '{"mode":"ours","task":"invoice_parser"}'`
- [ ] The run ID is new and the `libraryId` is one you have not used in rehearsal. The case viewer is empty.
- [ ] 4 agent cards, all **Trusted**, step counts moving.

Rehearsal note: time how long a full run takes. If agents finish before 0:50 on the script, Bad note will return 409 (slot not active). Start the run later, not earlier, if that happens. Confirm with Avneh that `run/start` mints a fresh `libraryId` every time; this script assumes it does.

---

## On stage: the 3-minute script

Times are from the moment you start talking.

### 0:00 to 0:12: Open

DO: Dashboard already full screen. Stand to the side so the grid is visible.

SAY:
> "The ordinary habit is to spawn a helper, trust what it says, and start over when it is wrong."
>
> "This is Kept. Elevate the ordinary."
>
> "It keeps the one true line: a passing test, a corrected fact, a lesson. The next run starts higher."

### 0:12 to 0:30: Fleet at work

DO: Point at the agent grid, then the Relay feed, then the ledger panel.

SAY:
> "Four agents, all on GPT-6 Luna, building an invoice CSV parser. One function each."
>
> "Green means Trusted. This is their chat, over Agent Relay."
>
> "And this ledger counts every single API call, from the usage fields. No guessing."

IF IT BREAKS:
- Cards are not moving: "They're thinking. Each step is one model call plus a real test run." Keep going; step 2 does not need movement.
- Grid empty or the badge says MOCK or REPLAY: "Let me show you the recorded run instead; this is a recording." Switch to the backup video and narrate the same script over it.

### 0:30 to 0:50: Shared reasoning

DO: Point at a verified note in the Relay feed (kind "note"), then at the **"reasoning reused (est.)"** counter in the ledger.

SAY:
> "When an agent's code passes its tests, its approach note gets shared."
>
> "Only then. Unverified ideas never spread."
>
> "This counter is the reasoning other agents didn't have to redo. It says 'est.' because it is an estimate. The real number comes from the benchmark."

IF IT BREAKS:
- No note yet, counter at 0: "No agent has passed its tests yet, so nothing gets shared. That's the point: nothing unverified spreads." Move on.

### 0:50 to 1:00: Bad note

DO: Pick a slot whose card is still working (step count below max, not done). Click **Bad note** on it. Say its slot number out loud.

SAY:
> "Bad note on agent [slot]. I left a false rule on one working agent."
>
> "On its next step it will claim its tests pass, and tell its teammates to break the spec."
>
> "Our orchestrator injects this. It fires every time."

IF IT BREAKS:
- Bad note returns 409 (slot not active): pick another card that is still working and press Bad note again. SAY: "That one already finished. Leaving the note on this one instead."
- All slots are done: "The fleet finished before I could leave the note. Here's the bad note from our recording." Switch to the backup video for steps 3 to 5, then come back for the crash test.

### 1:00 to 1:30: Catch

The bad note lands on the agent's next step, so expect a few seconds of nothing. Talk over it.

DO: Point at each of these as it happens. Order may vary.
1. The card with the bad note turns **Under investigation**.
2. The Relay feed shows its message **struck through**, with the block reason.
3. The card turns **Retired**.
4. A new case appears in the case list.
5. A new card for the same slot, generation 2, on **Probation**.

SAY (filler while waiting):
> "Here's the thing. We don't ask a model whether it lied. We just run the tests."

SAY (as it lands):
> "Tests failed. Caught."
>
> "Its message to the team never got delivered. Jev, TypeSafe's judge model, flagged it as breaking the spec. Struck through."
>
> "Retired. A case file is written: the claim, the test output, the lesson."
>
> "And a replacement takes over with only the code that actually passed. On probation until it proves itself."

IF IT BREAKS:
- Nothing after 20 seconds: "Model calls are being slow, so here's the same moment from our recording." Switch to the backup video at the bad-note timestamp, narrate, come back for the crash test.
- "Jev offline, using fallback" banner appears: "Jev is unreachable right now, so our fallback judge is answering. That's by design: the check never just switches off." Keep going.
- The message is not struck through, but the retire happens: say only what you see. "Tests caught it." Skip the Jev line.

### 1:30 to 1:50: Kept lesson

DO: Click the case in the case viewer. Best case to show: the invoice trap case (the starter comment says amounts are in cents; the spec says dollars). That invoice line is an example. If there is only the bad-note case, show that one. Point at the lesson, then at the recipients list and their replies.

SAY:
> "The lesson goes only to agents it's relevant to. Here are the ones that got it. The lesson is kept."
>
> "This case is an example. A comment in the starter file says amounts are in cents. The spec says dollars."
>
> "One agent fell for it. The others got the lesson and steered clear."

IF IT BREAKS:
- No recipients yet: "The case goes out on each agent's next step, so it's still in flight." Move on; do not claim it was avoided.
- Recipients but no "avoided trap" mark: drop the last line. Say only: "These agents received the lesson and replied with how it applies to them."

### 1:50 to 2:20: Crash test

DO: Switch to the STAGE terminal tab. Type or paste:

```bash
kill -9 $(lsof -t -iTCP:7100 -sTCP:LISTEN) $(lsof -t -iTCP:3000 -sTCP:LISTEN)
```

SAY:
> "Now the scary part. I'm killing the actor runtime and the orchestrator. kill -9. No graceful shutdown."

DO: Switch back to the dashboard. Point at the **"Reconnecting"** banner.

SAY:
> "Dashboard's reconnecting. Now bring them back."

DO: STAGE tab, run the restart line (press the up arrow until it shows, or paste):

```bash
(cd actors && nohup bunx durable-actors dev > /tmp/ss-actors.log 2>&1 &); sleep 3; (cd orchestrator && nohup bun run dev > /tmp/ss-orch.log 2>&1 &)
```

DO: Back to the dashboard. Point at the grid, the case list and the ledger totals.

SAY:
> "Same agents. Same statuses. Same case files. Same totals. To the cent."
>
> "All the state lives in Durable Actors, so nothing was in the processes we killed. The agents just carry on."

Notes:
- Only take the listening process (`-sTCP:LISTEN`). Without it, `lsof` also returns the browser's connections and you will kill Chrome.
- Rehearsal check: right after the kill, `lsof -nP -iTCP:7100 -iTCP:3000 -sTCP:LISTEN` must print nothing. If a watcher process respawns a listener on its own, tell Avneh before 3:40.
- Do not run the reset script. Ever. Not on stage.

IF IT BREAKS:
- Restart prints "address already in use": run the kill line again, then the restart line. SAY: "One more time, with feeling."
- Banner stays on after 20 seconds: "Taking its time. Here's the same test from this afternoon's recording." Switch to the backup video at the crash test, narrate, then go straight to the close. Avneh fixes it in the background.
- State came back different (a total or status changed): say exactly what you see. "The ledger came back; one card is still catching up." Do not claim "the same".

### 2:20 to 2:40: Swarm simulator

DO: Click **Swarm 100**. Point at the swarm panel. Then click **Swarm 1,000**. (Or `curl -s -X POST http://127.0.0.1:3000/api/swarm/start -H 'content-type: application/json' -d '{"agents":100}'`, then 1000.)

SAY:
> "Same machinery, scaled up. These are simulated agents, no model calls, each one a durable actor."
>
> "A hundred. Now a thousand."
>
> "[read off screen: N] agents, [read off screen: rate] state changes a second, and [read off screen: lost] lost. Measured, right now."

Read the numbers off the panel as they are. If "lost" is not zero, say the number anyway.

IF IT BREAKS:
- Laptop stalls at 1,000: stop at 100. SAY: "We'll stay at a hundred; I'd like to keep my laptop." Read the 100-agent numbers.
- Swarm cut at 3:15 PM: skip this step and spend the 20 seconds on the close.

### 2:40 to 3:00: Benchmark close

DO: Click the Results panel. Point at success rate, then recovery time, then net cost.

SAY:
> "We ran it head to head against real Codex subagents. Same model, same tasks, same traps, same time limit."
>
> "On our 3-task benchmark against Codex subagents, [X% from bench/results.json] higher success at [Y% from bench/results.json] lower net cost, with [Z% from bench/results.json] faster recovery."
>
> "That's in our runs. Three trials per task. Every run counted, overhead included."
>
> "Kept. Thanks."

IF IT BREAKS:
- Chart does not render: read the sticky-note numbers. SAY: "The chart's being shy, but here are the numbers, straight from our results file."
- A metric came out worse for us: drop that clause. Never reword a loss as a win.

---

## 30-second version (if time is cut)

Before you walk up: press **Bad note** on an active slot so the catch is already on screen when you start.

| Time | DO | SAY |
| --- | --- | --- |
| 0:00 to 0:08 | Point at the grid | "The ordinary habit is to trust the helper and start over. Kept keeps the one true line." |
| 0:08 to 0:18 | Point at the retired card, the struck-through message, the new Probation card | "I left a bad note on this one. Real tests caught the false rule, Jev blocked its message, and a replacement took over with only verified code." |
| 0:18 to 0:24 | Point at the case recipients | "The lesson went to the agents it matters to. That lesson is kept." |
| 0:24 to 0:30 | Point at the Results chart | "Against Codex subagents, on our 3-task benchmark: [X%] higher success at [Y%] lower net cost, with [Z%] faster recovery, in our runs. Thanks." |

---

## Backup video

- Recorded at 3:30 to 3:35 PM by one person, following this exact script, on the live system.
- Title card or caption: "Recorded today, live system."
- Note the timestamps of the bad note, the catch, the kept lesson and the crash test on the sticky note, so you can jump to them.
- If you switch to it on stage, say once: "This is a recording from this afternoon." Then narrate as normal.

---

## Likely judge questions

**Who watches the watchers?**
Tests first. A "tests pass" claim is settled by actually running pytest, not by a model. Jev only judges things that can be read from text, like "does this message break the spec?". Anything it is unsure about (between 0.15 and 0.85) goes to a fallback judge. The lesson writer only sees the spec and the evidence, never the agent's own reasoning. Lessons and shared notes can be revoked. And we count false retires in the benchmark: [N false retires from bench/results.json].

**Doesn't the overhead eat the savings?**
We count it. Every Jev call, fallback call, embedding, lesson and case-thread message is a ledger row from real usage fields, filed as overhead. The headline is net cost: what Codex spent minus what we spent, overhead included. Jev is $0.042 per million input tokens, output free. In the demo run, overhead was [overhead share: overheadUsd / (workerUsd + overheadUsd), read off the ledger panel] of our spend.

**What if a shared chunk is wrong?**
A note is only shared after the code it describes passed its tests and Jev found it consistent with the spec. Agents on probation can't share at all. If code built on a chunk later fails its tests, the chunk is revoked and every agent that used it gets a direct message saying so.

**Why not just use an LLM judge?**
Because a judge can be talked into things and pytest can't. Code claims go to tests. For text judgments, Jev gives a typed answer with a probability we can threshold, it's fast (2-second timeout) and costs a fraction of a cent. We do use an LLM judge, but only where it earns its cost: the uncertain middle band, and as the fallback when Jev is down.

**Is the Codex baseline fair?**
Same tasks, traps, planted note and model (GPT-6 Luna). Same "the spec is the source of truth" rule, in Codex's AGENTS.md. Same 10-minute limit. One custom worker subagent, and the event stream has to show subagents spawning; a run where Codex did everything itself is reported as such. Codex runs on its own OpenAI project, so we cross-check its cost against OpenAI's usage page. Every trial counts, no reruns. The faults we inject live (false success, invented API, conflicting instruction) are left out of the head-to-head, because we can't inject them into Codex.

**What's measured and what's simulated?**
Measured: the benchmark (real `codex exec` runs and real runs of ours, tokens from API usage fields, one price table for both), the live ledger, recovery times. Estimated, and labeled "est.": the live "reasoning reused" counter. Simulated: the swarm agents. They make no model calls; the swarm shows that the state layer handles that many agents, and the numbers on that panel are measured, not assumed.

**Is three trials enough?**
It's small, so we say "in our runs", not "significant", and we show min and max per mode, not just the mean.

**Does the warm case library make you look better?**
That's why the headline is cold mode: an empty case library and reasoning store. Warm mode is reported separately.

**What happens to a retired agent's late reply?**
It's rejected. Every write carries the agent's generation, and writes from a retired generation are refused. Its Relay identity is released at retire, so it can't send anything either.

---

## Filling in the numbers

Fill these from `bench/results.json` before 3:40 PM. Compare `ours_cold` with `codex_baseline` only. Warm and ablation are reported separately.

| Placeholder | How to compute | Value |
| --- | --- | --- |
| X% higher success | Success rate per mode = passing rows / all rows (crashes and killed runs count as failed). X = (ours − codex) / codex × 100. Also note the raw counts, e.g. [a]/9 vs [b]/9. | [ ] |
| Y% lower net cost | Net cost per mode = sum of `usd` over all its rows (ours includes overhead). Y = (codex − ours) / codex × 100. | [ ] |
| Z% faster recovery | Mean `recoverySec` per mode over rows where it is not null. Z = (codex − ours) / codex × 100. Note how many Codex rows never recovered (null). | [ ] |
| False retires | Sum of `falseRetires` over `ours_cold` rows | [ ] |

Rules for the numbers:
- Round down, not up.
- If X is computed as a relative change, say "% higher", not "percentage points". If the raw counts are more striking, say those instead.
- If any metric favors Codex, drop that clause from the claim. Do not swap in a different metric on stage that you have not checked.
- If fewer than 18 rows are in the file, say "in [N] runs" instead of "three trials per task".
