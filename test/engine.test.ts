import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { defaultConfig, validateConfig } from "../server/config.ts";
import { Engine, type Run } from "../server/engine.ts";
import { DemoHost } from "../server/demo.ts";
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
