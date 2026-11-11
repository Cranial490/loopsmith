import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { StreamParser, usageSince } from "../server/streams.ts";
import { defaultConfig } from "../server/config.ts";
import { Engine } from "../server/engine.ts";
import { DemoHost } from "../server/demo.ts";
import { sumUsage } from "../server/streams.ts";
import type { Step } from "../server/engine.ts";

const j = (o: unknown) => JSON.stringify(o) + "\n";
const feed = (p: StreamParser, s: string, size = 7) => { for (let i = 0; i < s.length; i += size) p.push(s.slice(i, i + size)); p.flush(); return p; };

test("claude: live estimate from assistant events (deduped by message id), then the final result wins", () => {
  const u = (o: number) => ({ input_tokens: 2, output_tokens: o, cache_read_input_tokens: 100, cache_creation_input_tokens: 50 });
  const p = new StreamParser("claude-stream-json");
  // The same message is repeated once per content block; it must count once.
  feed(p, j({ type: "assistant", message: { id: "m1", content: [{ type: "thinking" }], usage: u(3) } }) + j({ type: "assistant", message: { id: "m1", content: [{ type: "tool_use" }], usage: u(3) } }));
  assert.deepEqual(p.usage, { input: 2, output: 3, cacheRead: 100, cacheWrite: 50, total: 155, partial: true });
  feed(p, j({ type: "assistant", message: { id: "m2", content: [], usage: u(9) } }));
  assert.equal(p.usage?.total, 155 + 161);
  feed(p, j({ type: "result", result: "ok", total_cost_usd: 0.1, usage: { input_tokens: 4, output_tokens: 146, cache_read_input_tokens: 43962, cache_creation_input_tokens: 20798 } }));
  assert.deepEqual(p.usage, { input: 4, output: 146, cacheRead: 43962, cacheWrite: 20798, total: 4 + 146 + 43962 + 20798 });
  assert.equal(p.cumulative, false);
  assert.equal(p.costUsd, 0.1);
  assert.equal(p.result, "ok");
});

test("claude: missing usage fields stay missing; a result without usage keeps the live estimate", () => {
  const p = feed(new StreamParser("claude-stream-json"), j({ type: "result", result: "x", usage: { output_tokens: 5 } }));
  assert.deepEqual(p.usage, { output: 5, total: 5 });
  const q = feed(new StreamParser("claude-stream-json"), j({ type: "assistant", message: { id: "a", content: [], usage: { input_tokens: 1, output_tokens: 1 } } }) + j({ type: "result", result: "x" }));
  assert.deepEqual(q.usage, { input: 1, output: 1, total: 2, partial: true });
  assert.equal(feed(new StreamParser("claude-stream-json"), j({ type: "result", result: "x" })).usage, undefined);
});

test("codex --json: input_tokens includes cached input, so cache is split out, not added twice", () => {
  const p = feed(new StreamParser("codex-json"), j({ type: "thread.started", thread_id: "t" }) + j({ type: "turn.completed", usage: { input_tokens: 17435, cached_input_tokens: 16256, cache_write_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0 } }));
  assert.deepEqual(p.usage, { input: 1179, cacheRead: 16256, cacheWrite: 0, output: 5, total: 17440 });
  assert.equal(p.cumulative, true);
  // A printed turn.completed inside command output is not an event (it is not a top-level line in --json mode).
  assert.equal(feed(new StreamParser("text"), j({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } })).usage, undefined);
});

test("codex text: the 'tokens used' footer is a total without a breakdown", () => {
  const p = feed(new StreamParser("text"), "OpenAI Codex v0.154.0\n--------\ncodex\nhi\ntokens used\n4,976\n");
  assert.equal(p.usage?.total, 4976);
  assert.equal(p.usage?.input, undefined);
  assert.equal(p.cumulative, true);
  // Without the Codex banner, the same words are just output.
  assert.equal(feed(new StreamParser("text"), "tokens used\n12\n").usage, undefined);
});

test("usageSince subtracts an earlier cumulative report; a reset counter is not subtracted", () => {
  const a = { input: 100, cacheRead: 50, output: 10, total: 160 };
  assert.deepEqual(usageSince({ input: 150, cacheRead: 80, output: 15, total: 245 }, a), { input: 50, cacheRead: 30, output: 5, total: 85 });
  assert.equal(usageSince({ input: 10, cacheRead: 5, output: 1, total: 16 }, a), undefined);
});

test("sumUsage: totals across attempts, ignores shell/approval steps, flags missing or partial data", () => {
  const s = (o: Partial<Step>): Step => ({ index: 0, stageId: "fix", stageName: "Fix", type: "agent", attempt: 1, status: "done", startedAt: "", ...o });
  const steps = [
    s({ usage: { input: 10, output: 5, cacheRead: 100, total: 115 } }),
    s({ attempt: 2, usage: { input: 1, output: 2, total: 3 } }),
    s({ type: "shell" }),
    s({ type: "approval" }),
  ];
  assert.deepEqual(sumUsage(steps), { input: 11, output: 7, cacheRead: 100, total: 118, steps: 2, incomplete: false });
  assert.equal(sumUsage([...steps, s({ status: "failed" })])!.incomplete, true);
  assert.equal(sumUsage([...steps, s({ usage: { total: 1, partial: true } })])!.incomplete, true);
  assert.equal(sumUsage([s({ type: "shell" })]), undefined);
  assert.deepEqual(sumUsage([s({})]), { total: 0, steps: 0, incomplete: true });
});

test("engine: codex session continuation stores per-step usage (no double count), persisted across restarts", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ls-usage-"));
  const git = (...a: string[]) => execFileSync("git", a, { cwd: repo });
  git("init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "a.txt"), "a");
  git("add", "."); git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  const cfg = defaultConfig();
  cfg.worktreeDir = "wt";
  const ev = (input: number, cached: number, output: number) =>
    `echo '{"type":"thread.started","thread_id":"01a1c88b-73c6-76d0"}'; echo '{"type":"turn.completed","usage":{"input_tokens":${input},"cached_input_tokens":${cached},"output_tokens":${output}}}'`;
  cfg.harnesses = {
    codex: { ...cfg.harnesses.codex, command: "bash", args: ["-c", ev(1000, 800, 10)], resumeArgs: ["-c", ev(2500, 2000, 30), "x", "{{sessionId}}"], continueArgs: undefined },
  };
  cfg.pipeline = [
    { id: "a", type: "agent", harness: "codex", prompt: "x", writeHandoff: false },
    { id: "b", type: "agent", harness: "codex", prompt: "x", writeHandoff: false, continueSession: true },
    { id: "s", type: "shell", command: "echo hi" },
  ];
  const engine = new Engine(repo, () => cfg, new DemoHost());
  const [run] = engine.enqueue([{ number: 1, title: "t" }], { autoApprove: true });
  const t = Date.now();
  while (run.status !== "done") { if (Date.now() - t > 20000) throw new Error(`timeout: ${run.status} ${run.error}`); await new Promise((r) => setTimeout(r, 50)); }
  const [a, b, sh] = run.steps;
  assert.equal(b.sessionId, a.sessionId);
  assert.deepEqual(a.usage, { input: 200, cacheRead: 800, output: 10, total: 1010 });
  assert.deepEqual(b.usage, { input: 300, cacheRead: 1200, output: 20, total: 1520 });
  assert.equal(sh.usage, undefined);

  const reloaded = new Engine(repo, () => cfg, new DemoHost()).runs.get(run.id)!;
  assert.deepEqual(reloaded.steps[1].usage, b.usage);
});

test("config: the old Codex default (text, no --json) is upgraded; customized Codex args are kept", async () => {
  const { loadConfig } = await import("../server/config.ts");
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ls-cfg-"));
  const old = ["--dangerously-bypass-approvals-and-sandbox", "--output-last-message", "{{outputFile}}"];
  const cfg = defaultConfig();
  cfg.harnesses.codex = { command: "codex", args: ["exec", ...old, "{{prompt}}"], resumeArgs: ["exec", ...old, "resume", "{{sessionId}}", "{{prompt}}"], sessionIdPattern: "session id:\\s*([0-9a-fA-F-]{8,})" };
  cfg.harnesses.mine = { command: "codex", args: ["exec", "--model", "x", "{{prompt}}"], format: "text" };
  fs.writeFileSync(path.join(repo, "loopsmith.config.json"), JSON.stringify(cfg));
  const got = loadConfig(repo);
  assert.equal(got.harnesses.codex.format, "codex-json");
  assert.ok(got.harnesses.codex.args.includes("--json"));
  assert.match('{"type":"thread.started","thread_id":"01a1c88b-73c6-76d0"}', new RegExp(got.harnesses.codex.sessionIdPattern!));
  assert.deepEqual(got.harnesses.mine, cfg.harnesses.mine);
});
