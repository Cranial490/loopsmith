# loopsmith

Run your issue loop on autopilot: **pick GitHub issues → implement → AI review → fix until score ≥ 8 → approve → merge**, with a live UI. Each stage can use a different agent CLI (Claude Code, Codex, Pi, or any other CLI), and you can add your own stages.

```
issue ─▶ worktree ─▶ Implement (claude) ─▶ AI review (codex) ──score ≥ 8──▶ Human approval ─▶ Merge PR
                                              ▲        │
                                              └─ Fix ◀─┘ score < 8   (max 5 reviews, then "needs attention")
```

## Quick start

```bash
npm install

npm run demo           # try it with fake agents + fake issues (no tokens used)
# open http://localhost:4317

npm start -- --repo /path/to/your/repo   # real mode
```

Real mode needs `gh` (logged in) and the agent CLIs you use on your `PATH`. On the first start, loopsmith writes `loopsmith.config.json` into your repo. You can edit it in the **Pipeline** tab or by hand.

You can also link it: `npm link`, then run `loopsmith` inside any repo.

`npm start`, `npm run demo`, and the linked `loopsmith` command build the UI before starting the server. A failed build stops startup, so an outdated UI cannot be served with a newer API. After updating Loopsmith, restart it and reload the browser tab. `npm run dev` continues to use Vite's live development server.

## How it works

- **One worktree per issue.** Each run gets its own folder (`../.loopsmith-worktrees/issue-N`) and branch (`loop/issue-N`), made from the newest `origin/<baseBranch>`. Your main checkout is not touched. The worktree is removed when the run is done.
- **Max parallel = 1 (default)** means one issue at a time, all the way to merge. A run that waits for your approval keeps its slot. So issue #5 starts from a `main` that already has #4 merged. Raise the limit if your issues are independent.
- **Pipeline = list of stages.** Stages run top to bottom. A stage can jump with rules, for example `if score >= 8 → approve, else → fix`. That is how the review loop works.
- **Stage types**
  - `agent`: runs a harness with a prompt template. Can pull variables from the output with a regex (for example `score` from `SCORE: 8/10`, `Score 8/10` or `**Score:** 8/10`). Can continue the last session of the same harness (useful for "fix").
  - `shell`: runs a bash command in the worktree (merge, `npm test`, a lint gate, …).
  - `approval`: waits for you in the UI. In **hands-off** mode (a checkbox when you start runs) it passes on its own.
- **Safety limits.** `maxRuns` on a stage stops endless loops. The run goes to *needs attention*, and you can resume it with the limits reset.
- **Restart-safe.** State is in `<repo>/.loopsmith/` (git-ignored). If loopsmith stops, running runs show as *interrupted*. Press *Resume* to run that stage again.
- **Live view.** Every stage streams its log to the UI. Claude Code and Codex output is formatted: agent messages (Markdown), expandable tool calls and commands, highlighted errors, and folded startup noise. A Raw toggle shows the original stdout/stderr, which is always saved, and you can copy it. You can also see the exact prompt and the final output of each step.

## Handoff notes between agents

Agents do not share memory. Each one starts with a new conversation. So, by default, every agent stage:

1. **Writes a note.** loopsmith adds an instruction to the end of the prompt: write a short note (*What I did / Decisions and why / Not done / Instructions for the next agent*) to a file outside the repo (`<repo>/.loopsmith/handoff/<run>/<step>.md`). The path is also in the env var `LOOPSMITH_HANDOFF_FILE`.
2. **Gets the earlier notes.** All notes from earlier agents in the run (oldest first) go at the top of the prompt, before `## Your task`. If they are longer than `handoffMaxChars`, the oldest notes are left out first.

You can turn writing or reading off for each stage in the Pipeline tab, and change the note format under Settings. To put the notes in a different place in a prompt, use `{{handoff}}`. Each step's note is in the **handoff** tab of the run view, and the **prompt** tab shows what the agent got.

## Prompt variables

`{{handoff}} {{issue.number}} {{issue.title}} {{issue.body}} {{branch}} {{baseBranch}} {{pr.number}} {{pr.url}} {{iteration}} {{vars.score}} {{stages.<id>.output}}`

The PR is found on its own (`gh pr list --head <branch>`) after each stage. The implement prompt tells the agent which branch to use.

## Agents can ask you questions

A headless agent cannot pause in the middle of its work. So loopsmith uses a file, like for handoff notes:

1. Each agent prompt gets an instruction: if you need a decision from the human, write your questions (with options and a recommendation) to a file, then stop.
2. When the agent stops with questions, the run shows **Has a question** and you get a notification. The run keeps its queue slot.
3. You type the answers in the UI. The same stage runs again and continues the agent's own session, so it still knows what it did. If the session cannot be continued, the agent gets the full task again plus the questions and answers.
4. Your answers are also saved as a handoff note, so the reviewer and the fixer know what you decided.

In **hands-off** mode nobody can answer, so agents are told not to ask and to record assumptions. You can turn questions off for one stage in the Pipeline tab ("May stop and ask you questions"), and change the instruction text under Settings.

## You stay in control

- **Approve**, **Reject**, or **Send back with notes** at an approval stage. Your notes go to the fix agent as the newest handoff note, then review and approval run again.
- **Run from stage…** starts a stopped or finished run again from any stage.
- **Notify me** (top bar) gives a desktop notification when a run needs you. The tab title shows the count.
- Each Claude step shows its cost, and each run shows the total.

## Specs page

**Specs ↗** in the top bar opens the Specs page (`/#/specs`) in a new window, so it can sit next to the Runs view.

- It lists the open issues with the `spec` label. Select one to see its body and its tickets as a graph.
- A spec's tickets are its GitHub sub-issues, plus issues whose body has a `Part of #N` line or a `## Parent` heading followed by `#N`.
- Tickets are in columns by depth: a ticket sits one column after its deepest blocker in the spec. Arrows go from a blocker to the ticket it blocks.
- Each ticket shows the status of its latest run. A closed ticket with no run shows as closed. Click a ticket that has a run to open the run.

## Queue rules

- Runs start in issue-number order, but an issue blocked by issue N always starts after issue N. Blockers come from GitHub's native "blocked by" links and from a `Blocked by #N` section in the issue body (the format `/to-issues` writes); both are used together. The issue list shows `after #N`, and warns you when you select an issue without its open blocker.
- A run that waits for approval keeps its slot. A run that failed, was interrupted, or needs attention keeps it too (`holdQueueOnProblem`). So the next issue never starts on top of unmerged or broken work. Resume, stop or delete the run to free the slot.

## What happens when things go wrong

| Problem | What loopsmith does |
|---|---|
| The reviewer gives no `SCORE:` line | The stage fails and is tried again (`retries`). An old score is never used. |
| Implement ends with no PR | The stage fails with "no PR found" (`requirePr`). |
| An agent hangs | `timeoutMinutes` stops it. Then `retries` applies. |
| An agent CLI is not installed | The stage fails with "failed to start". |
| A loop does not end | `maxRuns` stops it: *needs attention*. |
| You close loopsmith (Ctrl-C) | All agents are stopped. Runs show as *interrupted*. Queued runs start again on the next start. |
| A new worktree has no dependencies or `.env` | `setupCommand` (for example `npm ci`) and `copyFiles` run once for each new worktree. |

## Harnesses

A harness is a command plus arguments, one per line in the Pipeline tab.

- `{{prompt}}`: the full prompt as one argument.
- `{{outputFile}}`: a temp file. If the CLI writes its final answer there, that becomes the stage output. Otherwise loopsmith uses stdout.
- **Sessions.** A stage with "continue an earlier session" continues one exact session, not "the most recent one". loopsmith saves the session id of each step: it finds the id in the output (`sessionIdPattern`), or it chooses the id (`{{newSessionId}}`). `resumeArgs` then gets it as `{{sessionId}}`. In the default pipeline, *fix* continues the newest session of *implement* or *fix*, and never the reviewer's.

Defaults (the Codex and Pi flags are from their docs and are not tested here; check them with `--help`):

| id | new session | continue a session |
|---|---|---|
| claude | `claude -p <prompt> --dangerously-skip-permissions --output-format stream-json --verbose` | `… --resume <id>` |
| codex | `codex exec --json --dangerously-bypass-approvals-and-sandbox --output-last-message <file> <prompt>` | `codex exec <flags> resume <id> <prompt>` |
| pi | `pi -p --session-id <new id> <prompt>` | `pi -p --session <id> <prompt>` |

If your Pi version does not know `--session-id`, remove that flag and the `resumeArgs`. loopsmith then uses the fallback `pi -c -p`.

### Token usage

Each agent step shows the tokens its CLI reported: input, output, cache read, cache write and a **total = input + cache read + cache write + output**. "input" never contains cached tokens, so nothing is counted twice. A stage shows its total over all attempts and review rounds, and the run shows its total; "(incomplete)" means some step reported nothing (failed, stopped, still running, an older run) or only a live estimate. Shell and approval steps have no token usage. Token counts are not a charge, and the dollar cost stays a separate number.

- **Claude Code** (`claude-stream-json`): the `result` event's `usage` is the usage of that one `claude -p` process, also when it resumes a session. `input_tokens` excludes cache, `cache_read_input_tokens` / `cache_creation_input_tokens` are the cache read / write. While it runs, the `assistant` events give a live estimate (each message counted once, by message id); the final `result` replaces it.
- **Codex** (`codex-json`, `codex exec --json`): `turn.completed.usage` is the running total of the whole Codex session, and its `input_tokens` includes `cached_input_tokens`. loopsmith stores this total and subtracts the total of the earlier step in the same session, so a resumed session is not counted twice. Usage appears when the turn completes.
- **Codex text output** (older configs without `--json`): only the `tokens used` number (a session running total; Codex counts it without cached input), shown as a total without a breakdown. Older saved configs with the untouched default Codex args are upgraded to `--json` automatically.
- Custom harnesses report no usage unless they use one of these formats.

## Safety

- The agents run with permission checks off, because nobody is there to click "allow". They work in a separate worktree, but they have your shell, your `gh` login and your network. An issue body goes into the prompt as it is. Only run issues and repos you trust.
- The server listens on `127.0.0.1` only and refuses requests that do not come from this computer's own pages.
- Values put into shell stages (`{{branch}}`, `{{issue.title}}`, …) are quoted when they have unsafe characters. Do not put variables inside double quotes in a shell command.
- The merge stage does not use `gh pr merge --delete-branch`, because that fails inside a worktree. It merges, deletes the remote branch, and loopsmith removes the worktree and the local branch.

## Ideas for added stages

- `shell` stage `npm test && npm run lint` before review. It fails fast, without spending tokens on a review.
- A second `agent` reviewer with a different harness, then take the lower score.
- `agent` stage that runs `/stage-chapters` before the human approval step.
- `shell` stage after merge that moves the Linear ticket.

## Develop

```bash
npm run dev        # API in demo mode + Vite with hot reload on :5173
npm test           # engine tests (use the fake agent)
npm run typecheck
```
