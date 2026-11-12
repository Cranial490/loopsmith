import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { defaultConfig, loadConfig, validateConfig } from "../server/config.ts";
import { Engine, withModel, type Run } from "../server/engine.ts";
import { DemoHost } from "../server/demo.ts";
import { parseBlockers } from "../server/github.ts";
import { parseCodexModels } from "../server/models.ts";
import { evalCondition, extractVars, render } from "../server/template.ts";

const fake = path.resolve("demo/fake-agent.mjs");

function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ls-test-"));
  const git = (...a: string[]) => execFileSync("git", a, { cwd: repo });
  git("init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "a.txt"), "a");
  git("add", "."); git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  const cfg = defaultConfig();
  cfg.worktreeDir = "wt";
  for (const h of Object.values(cfg.harnesses)) { h.command = process.execPath; h.args = [fake, "{{prompt}}"]; h.continueArgs = undefined; h.resumeArgs = [fake, "--resume", "{{sessionId}}", "{{prompt}}"]; h.sessionIdPattern = "session id:\\s*(\\S+)"; h.format = "text"; }
  cfg.retryDelaySeconds = 0;
  (cfg.pipeline.find((s) => s.id === "merge") as any).command = "echo merged {{pr.number}}";
  return { repo, cfg };
}

const waitFor = async (fn: () => boolean, ms = 30000) => {
  const t = Date.now();
  while (!fn()) { if (Date.now() - t > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 100)); }
};

test("template + conditions", () => {
  assert.equal(render("PR #{{pr.number}} {{x.y}}", { pr: { number: 7 } }), "PR #7 ");
  assert.equal(evalCondition("score >= 8", { vars: { score: 9 } }), true);
  assert.equal(evalCondition("score >= 8", { vars: { score: 7.5 } }), false);
  assert.equal(evalCondition("score >= 8", { vars: {} }), false);
  assert.deepEqual(extractVars("SCORE: 4/10\n...\nSCORE: 8.5 / 10", { score: "SCORE:\\s*(\\d+(?:\\.\\d+)?)\\s*/\\s*10" }), { score: 8.5 });
  assert.deepEqual(validateConfig(defaultConfig()), []);
});

test("model args go before the prompt, or at the end", () => {
  const m = ["--model", "{{model}}"];
  assert.deepEqual(withModel(["exec", "--json", "resume", "{{sessionId}}", "{{prompt}}"], m), ["exec", "--json", "resume", "{{sessionId}}", "--model", "{{model}}", "{{prompt}}"]);
  assert.deepEqual(withModel(["run", "--prompt={{prompt}}"], m), ["run", "--prompt={{prompt}}", "--model", "{{model}}"]);
  assert.deepEqual(withModel(["-p", "{{prompt}}"], []), ["-p", "{{prompt}}"]);
  // A model already in the harness args is replaced, not given twice.
  assert.deepEqual(withModel(["exec", "--model", "gpt-6-astra", "resume", "{{sessionId}}", "{{prompt}}"], m), ["exec", "--model", "{{model}}", "resume", "{{sessionId}}", "{{prompt}}"]);
});

test("codex model list: every slug from `codex debug models`", () => {
  assert.deepEqual(parseCodexModels(JSON.stringify({ models: [{ slug: "gpt-6-astra", visibility: "list" }, { slug: "gpt-reserve", visibility: "hide" }] })), ["gpt-6-astra", "gpt-reserve"]);
});

test("default score regex reads the ways agents write a score", () => {
  const ex = (defaultConfig().pipeline.find((s) => s.id === "review") as any).extract;
  for (const t of ["SCORE: 8/10", "Score 8/10.", "**Score:** 8/10", "## Score: 8 / 10", "score = 8/10"]) {
    assert.deepEqual(extractVars(`review...\n${t}\n`, ex), { score: 8 }, t);
  }
  assert.deepEqual(extractVars("no score here, 3/10 tests fail", ex), {});
});

test("loadConfig upgrades the old default score regex", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ls-cfg-"));
  const cfg = defaultConfig();
  const review = cfg.pipeline.find((s) => s.id === "review") as any;
  review.extract = { score: "SCORE:\\s*(\\d+(?:\\.\\d+)?)\\s*/\\s*10" };
  fs.writeFileSync(path.join(repo, "loopsmith.config.json"), JSON.stringify(cfg));
  const got = loadConfig(repo).pipeline.find((s) => s.id === "review") as any;
  assert.deepEqual(extractVars("Score 8/10.", got.extract), { score: 8 });
});

test("implement → review loop → approval → merge", async () => {
  const { repo, cfg } = makeRepo();
  const engine = new Engine(repo, () => cfg, new DemoHost());
  const [run] = engine.enqueue([{ number: 2, title: "t" }], { autoApprove: false });
  await waitFor(() => run.status === "waiting_approval");
  assert.deepEqual(run.steps.map((s) => s.stageId), ["implement", "review", "fix", "review", "fix", "review", "approve"]);
  assert.deepEqual(run.steps.filter((s) => s.stageId === "review").map((s) => s.vars?.score), [5, 7, 9]);
  assert.equal(run.pr?.number, 102);
  assert.match(run.steps[2].prompt!, /gave it 5\/10/);
  assert.ok(fs.existsSync(path.join(repo, "wt/issue-2/feature-2.txt")));
  // The fixer continues the implementer's exact session, not the reviewer's.
  const [impl, rev, fix1, , fix2] = run.steps;
  assert.ok(impl.sessionId && rev.sessionId && impl.sessionId !== rev.sessionId);
  assert.match(fix1.command!, new RegExp(`--resume ${impl.sessionId} `));
  assert.match(fix2.command!, new RegExp(`--resume ${fix1.sessionId} `));
  assert.doesNotMatch(rev.command!, /--resume/);

  // Send back with notes: the fixer gets them, then review and approval run again.
  engine.sendBack(run.id, "Rename parseOrder to readOrder.");
  await waitFor(() => run.status === "waiting_approval" && run.steps.length === 10);
  assert.deepEqual(run.steps.slice(7).map((s) => s.stageId), ["fix", "review", "approve"]);
  assert.match(run.steps[7].prompt!, /You \(the human reviewer\)[\s\S]*Rename parseOrder to readOrder\./);

  engine.approve(run.id);
  await waitFor(() => run.status === "done");
  assert.equal(run.steps.at(-1)!.output!.trim(), "merged 102");
  assert.ok(!fs.existsSync(path.join(repo, "wt/issue-2")), "worktree removed");
});

test("hands-off mode + max runs stops the loop", async () => {
  const { repo, cfg } = makeRepo();
  (cfg.pipeline.find((s) => s.id === "review") as any).maxRuns = 2;
  const engine = new Engine(repo, () => cfg, new DemoHost());
  const [run] = engine.enqueue([{ number: 3, title: "t" }], { autoApprove: true });
  await waitFor(() => run.status === "needs_attention");
  assert.match(run.error!, /limit/);
  engine.resume(run.id, { resetLimits: true });
  await waitFor(() => run.status === "done");
  assert.equal(run.steps.find((s) => s.stageId === "approve")!.status, "skipped");
});

test("failed stage can be resumed; restart marks running as interrupted", async () => {
  const { repo, cfg } = makeRepo();
  cfg.pipeline = [{ id: "s", type: "shell", command: "test -f ok || (touch ok; exit 3)" }];
  const engine = new Engine(repo, () => cfg, new DemoHost());
  const [run] = engine.enqueue([{ number: 1, title: "t" }], { autoApprove: true });
  await waitFor(() => run.status === "failed");
  assert.equal(run.steps[0].exitCode, 3);
  engine.resume(run.id);
  await waitFor(() => run.status === "done");
  const fresh = new Engine(repo, () => cfg, new DemoHost());
  assert.equal((fresh.runs.get(run.id) as Run).status, "done");
});

test("maxParallel=1: next issue waits until the previous one is approved", async () => {
  const { repo, cfg } = makeRepo();
  cfg.pipeline = [{ id: "a", type: "approval" }, { id: "s", type: "shell", command: "true" }];
  const engine = new Engine(repo, () => cfg, new DemoHost());
  const [r1, r2] = engine.enqueue([{ number: 1, title: "a" }, { number: 2, title: "b" }], { autoApprove: false });
  await waitFor(() => r1.status === "waiting_approval");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(r2.status, "queued");
  engine.approve(r1.id);
  await waitFor(() => r1.status === "done" && r2.status === "waiting_approval");
});

test("handoff notes flow to the next agents", async () => {
  const { repo, cfg } = makeRepo();
  const engine = new Engine(repo, () => cfg, new DemoHost());
  const [run] = engine.enqueue([{ number: 4, title: "t" }], { autoApprove: true });
  await waitFor(() => run.status === "done");
  const [impl, review1, fix1] = run.steps;
  assert.match(impl.prompt!, /HANDOFF NOTE \(required\)/);
  assert.doesNotMatch(impl.prompt!, /Handoff notes from earlier agents/);
  assert.match(impl.handoff!, /received earlier notes: no/);
  assert.match(review1.prompt!, /From "Implement \(TDD\)"[\s\S]*Main file: src\/feature.ts[\s\S]*## Your task/);
  assert.match(fix1.prompt!, /From "Implement[\s\S]*From "AI review"/);
  assert.match(fix1.handoff!, /received earlier notes: yes/);
  assert.equal(run.handoffs.length, run.steps.filter((s) => s.type === "agent").length);
});

test("formatHandoffs drops oldest notes when too long", async () => {
  const { formatHandoffs } = await import("../server/engine.ts");
  const n = (i: number) => ({ stepIndex: i, stageId: "s", stageName: `S${i}`, attempt: 1, note: "x".repeat(100), at: "" });
  const out = formatHandoffs([n(1), n(2), n(3)], 300);
  assert.doesNotMatch(out, /S1"/);
  assert.match(out, /S3"/);
  assert.match(out, /older note\(s\) left out/);
});

test("score missing from the final answer is read from the handoff note", async () => {
  const { repo, cfg } = makeRepo();
  cfg.harnesses.sh = { command: "bash", args: ["-c", 'echo "Score 9/10." > "$LOOPSMITH_HANDOFF_FILE"; echo "Review complete."'] };
  cfg.pipeline = [{ id: "review", type: "agent", harness: "sh", prompt: "x", extract: { score: (defaultConfig().pipeline.find((s) => s.id === "review") as any).extract.score }, next: [{ when: "score >= 8", goto: "end" }] }];
  const engine = new Engine(repo, () => cfg, new DemoHost());
  const [run] = engine.enqueue([{ number: 1, title: "t" }], { autoApprove: true });
  await waitFor(() => run.status !== "running" && run.status !== "queued");
  assert.equal(run.error, undefined);
  assert.equal(run.status as string, "done");
  assert.equal(run.vars.score, 9);
});

test("review with no score: retried, then the run fails (never passes on an old score)", async () => {
  const { repo, cfg } = makeRepo();
  cfg.harnesses.sh = { command: "bash", args: ["-c", "echo I forgot the score"] };
  cfg.pipeline = [{ id: "review", type: "agent", harness: "sh", prompt: "x", writeHandoff: false, extract: { score: "SCORE: (\\d+)" }, retries: 1, next: [{ when: "score >= 8", goto: "end" }] }];
  const engine = new Engine(repo, () => cfg, new DemoHost());
  const [run] = engine.enqueue([{ number: 1, title: "t" }], { autoApprove: true });
  run.vars.score = 9; // an old score must not count
  await waitFor(() => run.status === "failed");
  assert.equal(run.steps.length, 2);
  assert.match(run.error!, /no score in the output/);
});

test("implement with no PR fails with a clear message; a missing CLI fails cleanly", async () => {
  const { repo, cfg } = makeRepo();
  cfg.pipeline = [cfg.pipeline[0]];
  const host = new DemoHost(); host.findPr = async () => undefined;
  const engine = new Engine(repo, () => cfg, host);
  const [run] = engine.enqueue([{ number: 1, title: "t" }], { autoApprove: true });
  await waitFor(() => run.status === "failed");
  assert.match(run.error!, /no PR found/);
  engine.remove(run.id);

  cfg.harnesses.claude.command = "no-such-cli-xyz";
  const [r2] = engine.enqueue([{ number: 2, title: "t" }], { autoApprove: true });
  await waitFor(() => r2.status === "failed");
  assert.equal(r2.steps[0].exitCode, 127);
});

test("queue: blocked issues wait, a failed run holds the queue, shutdown stops agents", async () => {
  const { parseBlockers } = await import("../server/github.ts");
  const { orderByBlockers } = await import("../server/engine.ts");
  assert.deepEqual(parseBlockers("## What\nSee #9\n\n## Blocked by\n\n- Blocked by #3\n- #4\n\n## Notes\n#7", 5), [3, 4]);
  assert.deepEqual(parseBlockers("## Blocked by\n\nNone - can start immediately"), []);
  assert.deepEqual(orderByBlockers([{ number: 2, title: "", blockedBy: [5] }, { number: 5, title: "" }, { number: 1, title: "" }]).map((i) => i.number), [1, 5, 2]);

  const { repo, cfg } = makeRepo();
  cfg.maxParallel = 2;
  cfg.pipeline = [{ id: "a", type: "approval" }, { id: "s", type: "shell", command: "test {{issue.number}} != 3" }];
  const engine = new Engine(repo, () => cfg, new DemoHost());
  const [r1, r2] = engine.enqueue([{ number: 2, title: "b", blockedBy: [1] }, { number: 1, title: "a" }], { autoApprove: false });
  assert.equal(r1.issue.number, 1);
  await waitFor(() => r1.status === "waiting_approval");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(r2.status, "queued"); // a slot is free, but #2 waits for #1
  engine.approve(r1.id);
  await waitFor(() => r1.status === "done" && r2.status === "waiting_approval");
  engine.approve(r2.id);
  await waitFor(() => r2.status === "done");

  cfg.maxParallel = 1;
  cfg.pipeline = [{ id: "s", type: "shell", command: "test {{issue.number}} != 3 && sleep 30" }];
  const [r3, r4] = engine.enqueue([{ number: 3, title: "c" }, { number: 4, title: "d" }], { autoApprove: true });
  await waitFor(() => r3.status === "failed");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(r4.status, "queued"); // #3 failed, so #4 does not start on top of it
  engine.remove(r3.id);
  await waitFor(() => r4.status === "running" && !!r4.steps[0]?.command);
  engine.shutdown();
  assert.equal(r4.status, "interrupted");
});

test("native blocked-by links: parsed, merged with text blockers, and they hold the queue", async () => {
  const { parseDependencies, withNativeBlockers } = await import("../server/github.ts");
  // The shape `gh api repos/{owner}/{repo}/issues/N/dependencies/blocked_by` returns.
  const deps = [
    { number: 3, html_url: "https://github.com/o/r/issues/3", repository_url: "https://api.github.com/repos/o/r" },
    { number: 9, html_url: "https://github.com/o/r/issues/9" },
    { number: 3, html_url: "https://github.com/o/r/issues/3" }, // duplicate
    { number: 5, html_url: "https://github.com/o/r/issues/5" }, // itself
    { number: 7, html_url: "https://github.com/other/repo/issues/7" }, // another repo: its number means nothing here
  ];
  const self = { number: 5, title: "t", url: "https://github.com/o/r/issues/5" };
  assert.deepEqual(parseDependencies(deps, self), [3, 9]);
  assert.deepEqual(parseDependencies([], self), []);
  assert.deepEqual(parseDependencies({ message: "Not Found" }, self), []);

  const withText = { ...self, body: "## Blocked by\n\n- #4\n- #3\n- #5" };
  assert.deepEqual((await withNativeBlockers(withText, async () => JSON.stringify(deps))).blockedBy, [3, 9, 4]);
  // The dependencies call fails: the text blockers are still used and nothing throws.
  assert.deepEqual((await withNativeBlockers(withText, async () => { throw new Error("gh api failed: HTTP 404"); })).blockedBy, [4, 3]);
  assert.deepEqual((await withNativeBlockers(withText, async () => "not json")).blockedBy, [4, 3]);

  // Demo mode has an issue whose only blocker is a native link.
  const host = new DemoHost();
  const issues = await host.listIssues();
  const native = issues.find((i) => i.blockedBy?.length && !parseBlockers(i.body, i.number).length)!;
  assert.ok(native, "the demo host has an issue blocked only by a native link");
  const blocker = issues.find((i) => i.number === native.blockedBy![0])!;

  const { repo, cfg } = makeRepo();
  cfg.maxParallel = 2;
  cfg.pipeline = [{ id: "a", type: "approval" }];
  const engine = new Engine(repo, () => cfg, host);
  const [r1, r2] = engine.enqueue([native, blocker], { autoApprove: false });
  assert.deepEqual([r1.issue.number, r2.issue.number], [blocker.number, native.number]);
  await waitFor(() => r1.status === "waiting_approval");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(r2.status, "queued"); // a slot is free, but the native blocker's run is not done
  assert.deepEqual(engine.waitingFor(r2), [blocker.number]);
  engine.approve(r1.id);
  await waitFor(() => r1.status === "done" && r2.status === "waiting_approval");
  engine.shutdown();
});

test("shell stages quote unsafe values", async () => {
  const { renderShell } = await import("../server/template.ts");
  assert.equal(renderShell("echo {{a}} {{b}} {{c}}", { a: "x; rm -rf /", b: "loop/issue-4", c: "it's" }), "echo 'x; rm -rf /' loop/issue-4 'it'\\''s'");
});

test("an agent can stop to ask a question; the answer continues its session", async () => {
  const { repo, cfg } = makeRepo();
  cfg.harnesses.claude.env = { FAKE_ASK: "1" };
  cfg.pipeline = cfg.pipeline.filter((s) => ["implement", "review"].includes(s.id));
  (cfg.pipeline[1] as any).next = [{ goto: "end" }];
  const engine = new Engine(repo, () => cfg, new DemoHost());
  const [run] = engine.enqueue([{ number: 1, title: "t" }], { autoApprove: false });
  await waitFor(() => run.status === "waiting_input");
  const ask = run.steps[0];
  assert.match(ask.question!, /Where must orders be stored/);
  assert.match(ask.prompt!, /QUESTIONS FOR THE HUMAN/);
  assert.equal(ask.handoff, undefined);
  assert.throws(() => engine.approve(run.id));
  engine.answer(run.id, "1. SQLite. 2. Yes.");
  await waitFor(() => run.status === "done");
  const [, cont, review] = run.steps;
  assert.equal(ask.status, "asked");
  assert.equal(cont.stageId, "implement"); // maxRuns 1 does not block the continued step
  assert.match(cont.command!, new RegExp(`--resume ${ask.sessionId} `));
  assert.match(cont.prompt!, /^The human answered your questions[\s\S]*1\. SQLite\. 2\. Yes\./);
  assert.match(review.prompt!, /questions answered by the human[\s\S]*1\. SQLite/); // the reviewer knows your decision

  // Hands-off: nobody can answer, so the agent is told not to ask.
  const [r2] = engine.enqueue([{ number: 2, title: "t" }], { autoApprove: true });
  await waitFor(() => r2.status === "done");
  assert.match(r2.steps[0].prompt!, /Do not ask questions/);
  assert.equal(r2.steps.length, 2);
});

test("stages do not inherit question/handoff paths from an outer Loopsmith run", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ls-outer-"));
  const outerQ = path.join(tmp, "outer-q.md"), outerH = path.join(tmp, "outer-h.md");
  fs.writeFileSync(outerQ, "SENTINEL-Q"); fs.writeFileSync(outerH, "SENTINEL-H");
  const saved = { q: process.env.LOOPSMITH_QUESTION_FILE, h: process.env.LOOPSMITH_HANDOFF_FILE, o: process.env.LS_ORDINARY };
  Object.assign(process.env, { LOOPSMITH_QUESTION_FILE: outerQ, LOOPSMITH_HANDOFF_FILE: outerH, LS_ORDINARY: "kept" });
  try {
    const { repo, cfg } = makeRepo();
    // Writes into whatever paths it sees, like a careless nested agent would.
    const script = 'echo "Q=${LOOPSMITH_QUESTION_FILE-none} H=${LOOPSMITH_HANDOFF_FILE-none} O=$LS_ORDINARY"; [ -z "$LOOPSMITH_QUESTION_FILE" ] || [ "$ASK" != 1 ] || echo "1. leaked?" > "$LOOPSMITH_QUESTION_FILE"; [ -z "$LOOPSMITH_HANDOFF_FILE" ] || echo "note" > "$LOOPSMITH_HANDOFF_FILE"';
    cfg.harnesses.sh = { command: "bash", args: ["-c", script], env: { ASK: "1" } };
    cfg.harnesses.sh2 = { command: "bash", args: ["-c", script] };
    cfg.pipeline = [
      { id: "off", type: "agent", harness: "sh", prompt: "x", allowQuestions: false, writeHandoff: false },
      { id: "on", type: "agent", harness: "sh2", prompt: "x" },
    ];
    const engine = new Engine(repo, () => cfg, new DemoHost());
    const [run] = engine.enqueue([{ number: 1, title: "t" }], { autoApprove: false });
    await waitFor(() => run.status === "done");
    const [off, on] = run.steps;
    assert.equal(off.output!.trim(), "Q=none H=none O=kept");
    assert.equal(off.question, undefined);
    assert.equal(fs.readFileSync(outerQ, "utf8"), "SENTINEL-Q");
    assert.equal(fs.readFileSync(outerH, "utf8"), "SENTINEL-H");
    const dataDir = path.join(repo, ".loopsmith");
    assert.equal(on.output!.trim(), `Q=${path.join(dataDir, "questions", run.id, "1.md")} H=${path.join(dataDir, "handoff", run.id, "1.md")} O=kept`);
    assert.equal(on.handoff, "note");
  } finally {
    for (const [k, v] of [["LOOPSMITH_QUESTION_FILE", saved.q], ["LOOPSMITH_HANDOFF_FILE", saved.h], ["LS_ORDINARY", saved.o]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

test("spec tickets: sub-issues JSON and parent lines are parsed and merged", async () => {
  const { parseSubIssues, parseParent, ticketsOf } = await import("../server/github.ts");
  // The shape `gh api repos/{owner}/{repo}/issues/N/sub_issues` returns.
  const subs = [
    { number: 21, title: "a", state: "open", html_url: "https://github.com/o/r/issues/21" },
    { number: 22, title: "b", state: "closed", html_url: "https://github.com/o/r/issues/22" },
    { number: 21, title: "a" }, // duplicate
    { number: 20 }, // the spec itself
    { number: 7, html_url: "https://github.com/other/repo/issues/7" }, // another repo: its number means nothing here
    { title: "no number" },
  ];
  const spec = { number: 20, url: "https://github.com/o/r/issues/20" };
  assert.deepEqual(parseSubIssues(subs, spec), [21, 22]);
  assert.deepEqual(parseSubIssues([], spec), []);
  assert.deepEqual(parseSubIssues({ message: "Not Found" }, spec), []);

  assert.equal(parseParent("Part of #20\n\nDo the thing."), 20);
  assert.equal(parseParent("## Parent\n\n#11\n\n## What to build\n\nSee #9"), 11);
  assert.equal(parseParent("Intro\n\n## Parent #20"), 20);
  assert.equal(parseParent("- **Part of:** #20"), 20);
  assert.equal(parseParent("This is not part of #20, see #3"), undefined); // not a parent line
  assert.equal(parseParent("## Parent\n\nNone\n\n## Blocked by\n\n- #4"), undefined); // #4 is a blocker, not the parent
  assert.equal(parseParent(undefined), undefined);

  const all = [
    { number: 20, title: "spec", body: "Part of #20" },
    { number: 21, title: "sub" },
    { number: 22, title: "sub and text", body: "Part of #20" },
    { number: 23, title: "text", body: "## Parent\n\n#20" },
    { number: 24, title: "other spec", body: "Part of #99" },
  ];
  assert.deepEqual(ticketsOf(20, all, [22, 21, 20]).map((i) => i.number), [21, 22, 23]);
});

test("spec graph: membership, edges, depth and status", async () => {
  const host = new DemoHost();
  // Demo mode has one open issue labelled `spec`. Closed specs and other issues are not listed.
  host.issues.push({ number: 90, title: "old spec", labels: ["spec"], state: "closed" });
  const specs = await host.listSpecs();
  assert.equal(specs.length, 1);
  const spec = specs[0];
  assert.ok(spec.labels?.includes("spec"));
  assert.ok((await host.listIssues()).every((i) => i.number !== 90), "closed issues are not in the open list");

  const { repo, cfg } = makeRepo();
  cfg.maxParallel = 4;
  cfg.pipeline = [{ id: "a", type: "approval" }];
  const engine = new Engine(repo, () => cfg, host);
  const g = await engine.specGraph(spec.number);
  assert.deepEqual({ number: g.number, title: g.title, body: g.body }, { number: spec.number, title: spec.title, body: spec.body });

  // Membership: sub-issues and text-parent tickets, each once, and never the spec.
  const nums = g.nodes.map((n) => n.number);
  assert.equal(nums.length, 4);
  assert.equal(new Set(nums).size, 4);
  assert.ok(!nums.includes(spec.number));
  const subs = host.subIssues[spec.number].map((s) => s.number);
  assert.ok(subs.length > 0 && subs.length < 4, "the demo spec links some tickets as sub-issues and some by text");
  const { parseParent } = await import("../server/github.ts");
  assert.ok(g.nodes.some((n) => !subs.includes(n.number) && parseParent(host.issues.find((i) => i.number === n.number)!.body) === spec.number));

  // A chain with one fork: root → two tickets → one that waits for both.
  const [root, left, right, last] = [...g.nodes].sort((a, b) => a.depth - b.depth || a.number - b.number);
  assert.deepEqual([root.depth, left.depth, right.depth, last.depth], [0, 1, 1, 2]);
  const edges = g.edges.map((e) => `${e.from}>${e.to}`).sort();
  assert.deepEqual(edges, [`${root.number}>${left.number}`, `${root.number}>${right.number}`, `${left.number}>${last.number}`, `${right.number}>${last.number}`].sort());
  assert.ok(g.nodes.every((n) => n.status === "not_started" && n.runId === undefined));

  // A blocker outside the spec gives no edge and no depth.
  host.dependencies[root.number] = [{ number: 1 }];
  const g2 = await engine.specGraph(spec.number);
  assert.equal(g2.edges.length, 4);
  assert.equal(g2.nodes.find((n) => n.number === root.number)!.depth, 0);
  delete host.dependencies[root.number];

  // Status comes from the latest run of each issue.
  const issues = await host.listTickets(spec.number);
  const pick = (n: number) => issues.find((i) => i.number === n)!;
  const [r1, r2] = engine.enqueue([pick(root.number), pick(left.number)], { autoApprove: false });
  await waitFor(() => r1.status === "waiting_approval");
  let now = await engine.specGraph(spec.number);
  const st = (n: number) => now.nodes.find((x) => x.number === n)!;
  assert.deepEqual([st(root.number).status, st(root.number).runId], ["waiting", r1.id]);
  assert.deepEqual([st(left.number).status, st(left.number).runId], ["queued", r2.id]);
  assert.equal(st(right.number).status, "not_started");
  engine.stop(r1.id);
  now = await engine.specGraph(spec.number);
  assert.equal(st(root.number).status, "needs_attention");

  // A newer run of the same issue wins.
  const [r3] = engine.enqueue([pick(root.number)], { autoApprove: true });
  await waitFor(() => r3.status === "done");
  now = await engine.specGraph(spec.number);
  assert.deepEqual([st(root.number).status, st(root.number).runId], ["done", r3.id]);

  cfg.pipeline = [{ id: "s", type: "shell", command: "false" }];
  const [r4] = engine.enqueue([pick(right.number)], { autoApprove: true });
  await waitFor(() => r4.status === "failed");
  now = await engine.specGraph(spec.number);
  assert.equal(st(right.number).status, "failed");

  // A closed ticket with no run shows as closed, and stays in the graph.
  host.issues.find((i) => i.number === last.number)!.state = "closed";
  now = await engine.specGraph(spec.number);
  assert.equal(st(last.number).status, "closed");
  assert.equal(now.nodes.length, 4);
  engine.shutdown();

  // A loop in the blockers must not hang the depth calculation.
  const { specDepths } = await import("../server/engine.ts");
  const d = specDepths([{ number: 1, title: "", blockedBy: [2] }, { number: 2, title: "", blockedBy: [1] }, { number: 3, title: "", blockedBy: [2] }]);
  assert.equal(d.size, 3);
});

test("spec graph: a GitHub failure is a readable error", async () => {
  const host = new DemoHost();
  host.listTickets = async () => { throw new Error("gh api failed: HTTP 502"); };
  const { repo, cfg } = makeRepo();
  const engine = new Engine(repo, () => cfg, host);
  await assert.rejects(engine.specGraph(10), /Could not load the tickets of spec #10 from GitHub: gh api failed: HTTP 502/);
  engine.shutdown();
});
