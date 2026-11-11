import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { formatLog, LogFormatter, type Block } from "../web/src/format.ts";
import { Markdown } from "../web/src/Markdown.tsx";
import { StreamParser } from "../server/streams.ts";
import { Engine } from "../server/engine.ts";
import { DemoHost } from "../server/demo.ts";
import { defaultConfig } from "../server/config.ts";

const kinds = (b: Block[]) => b.map((x) => x.kind);
const j = (o: unknown) => JSON.stringify(o) + "\n";

const claudeStream =
  j({ type: "system", subtype: "init", session_id: "abc-123", model: "claude-opus-5-5" }) +
  j({ type: "assistant", message: { content: [{ type: "text", text: "I'll **read** the file." }] } }) +
  j({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test -- " + "x".repeat(400) } }] } }) +
  j({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "12 passing", is_error: false }] } }) +
  j({ type: "result", subtype: "success", num_turns: 3, total_cost_usd: 0.42, result: "Done. Opened PR #7." });

test("Claude stream-json: messages, tool calls with full input + result, completion", () => {
  const blocks = formatLog([{ s: "out", t: claudeStream }]);
  assert.deepEqual(kinds(blocks), ["system", "message", "tool", "done"]);
  const tool = blocks[2] as Extract<Block, { kind: "tool" }>;
  assert.equal(tool.name, "Bash");
  assert.ok(tool.summary.length < 200, "summary is compact");
  assert.ok(tool.detail.includes("x".repeat(400)), "full command kept");
  assert.equal(tool.result, "12 passing");
  assert.equal(tool.error, false);
  const done = blocks[3] as Extract<Block, { kind: "done" }>;
  assert.match(done.title, /3 turns.*\$0\.42/);
  assert.equal(done.text, "Done. Opened PR #7.");
});

test("chunk boundaries: split JSON events give the same blocks; partial lines show live", () => {
  const whole = formatLog([{ s: "out", t: claudeStream }]);
  const chunks = claudeStream.match(/[\s\S]{1,7}/g)!.map((t) => ({ s: "out" as const, t }));
  assert.deepEqual(formatLog(chunks), whole);
  // A plain-text partial line is visible before its newline arrives.
  const partial = formatLog([{ s: "out", t: "building" }]);
  assert.deepEqual(partial, [{ kind: "output", text: "building" }]);
});

test("Claude error result: readable message first, raw JSON as detail", () => {
  const raw = 'API Error: 404 {"type":"error","error":{"type":"not_found_error","message":"model: claude-nope"}}';
  const blocks = formatLog([{ s: "out", t: j({ type: "result", subtype: "success", is_error: true, result: raw }) }]);
  assert.equal(blocks[0].kind, "error");
  const e = blocks[0] as Extract<Block, { kind: "error" }>;
  assert.equal(e.title, "model: claude-nope");
  assert.equal(e.detail, raw);
});

const codexText = [
  "OpenAI Codex v0.50.0 (research preview)",
  "--------",
  "workdir: /tmp/wt",
  "model: gpt-5-codex",
  "session id: 0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
  "--------",
  "user",
  "Review the PR. A very long prompt follows.",
  "thinking",
  "**Inspecting the diff**",
  "exec",
  "bash -lc 'git diff main' in /tmp/wt",
  " succeeded in 31ms:",
  "diff --git a/x b/x",
  "codex",
  "1. MAJOR: missing check.",
  "",
  "SCORE: 6/10",
  "tokens used",
  "4,210",
  "",
].join("\n");

test("Codex text output: header collapsed, prompt hidden, exec as tool, message as markdown", () => {
  const blocks = formatLog([{ s: "err", t: codexText }]);
  assert.deepEqual(kinds(blocks), ["noise", "noise", "thinking", "tool", "message", "done"]);
  const tool = blocks[3] as Extract<Block, { kind: "tool" }>;
  assert.equal(tool.summary, "git diff main");
  assert.match(tool.result!, /diff --git/);
  assert.equal(tool.error, false);
  assert.match((blocks[4] as any).text, /SCORE: 6\/10/);
  assert.match((blocks[5] as any).title, /4,210 tokens/);
});

test("Codex unsupported-model error is prominent; repeated retries are folded", () => {
  const err = [
    "stream error: unexpected status 400; retrying 1/5 in 200ms…",
    "stream error: unexpected status 400; retrying 2/5 in 400ms…",
    `ERROR: {"detail":"The 'gpt-9' model is not supported when using Codex with a ChatGPT account."}`,
    "",
  ].join("\n");
  const blocks = formatLog([{ s: "err", t: err }]);
  assert.deepEqual(kinds(blocks), ["noise", "error"]);
  const e = blocks[1] as Extract<Block, { kind: "error" }>;
  assert.equal(e.title, "The 'gpt-9' model is not supported when using Codex with a ChatGPT account.");
  assert.match(e.detail!, /^ERROR: \{"detail"/);
});

test("Codex --json events are formatted too", () => {
  const t =
    j({ type: "thread.started", thread_id: "th-1" }) +
    j({ type: "item.completed", item: { type: "agent_message", text: "All good." } }) +
    j({ type: "item.completed", item: { type: "command_execution", command: "bash -lc ls", aggregated_output: "a\n", exit_code: 1 } }) +
    j({ type: "turn.failed", error: { message: "quota exceeded" } });
  const blocks = formatLog([{ s: "out", t }]);
  assert.deepEqual(kinds(blocks), ["system", "message", "tool", "error"]);
  assert.equal((blocks[2] as any).error, true);
  assert.equal((blocks[3] as any).title, "quota exceeded");
});

test("plain text / unknown events / loopsmith lines / old saved logs stay readable", () => {
  const blocks = formatLog([
    { s: "sys", t: "$ node fake.mjs <prompt>\n\n" },
    { s: "out", t: "hello\nworld\n" + j({ type: "mystery", x: 1 }) },
    { s: "sys", t: "\n[loopsmith] handoff note saved (10 chars)\n" },
  ]);
  assert.deepEqual(kinds(blocks), ["tool", "output", "system"]);
  assert.match((blocks[1] as any).text, /hello\nworld\n\{"type":"mystery"/);
  // An old plain-text .log file (served as one chunk) still shows its lines.
  const old = formatLog([{ s: "out", t: "$ claude -p <prompt>\n\n● session x\n→ Bash npm test\n" }]);
  assert.ok(old.some((b) => b.kind === "output" && /→ Bash npm test/.test((b as any).text)));
});

test("Markdown renders lists, links, code; never raw HTML or unsafe links", () => {
  const html = renderToStaticMarkup(createElement(Markdown, {
    text: "# Title\n\n- one **bold**\n- two `code`\n\n1. first\n\n[site](https://x.dev) [bad](javascript:alert(1))\n\n```ts\nconst a = 1 < 2;\n```\n\n<script>alert(1)</script><img src=x onerror=alert(1)>",
  }));
  assert.match(html, /<h1>Title<\/h1>/);
  assert.match(html, /<ul><li>one <strong>bold<\/strong><\/li><li>two <code>code<\/code><\/li><\/ul>/);
  assert.match(html, /<ol><li>first<\/li><\/ol>/);
  assert.match(html, /<a href="https:\/\/x.dev"[^>]*>site<\/a>/);
  assert.doesNotMatch(html, /href="javascript/);
  assert.match(html, /<pre><code[^>]*>const a = 1 &lt; 2;<\/code><\/pre>/);
  assert.doesNotMatch(html, /<script|<img/);
  assert.match(html, /&lt;script&gt;/);
});

test("server keeps the Claude result/cost; formatting is not in the pipeline path", () => {
  const p = new StreamParser();
  for (const c of claudeStream.match(/[\s\S]{1,5}/g)!) p.push(c);
  p.flush();
  assert.equal(p.result, "Done. Opened PR #7.");
  assert.equal(p.costUsd, 0.42);
});

test("engine saves the original stdout/stderr per stream; old .log files are still served", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ls-fmt-"));
  const cfg = defaultConfig();
  const engine = new Engine(repo, () => cfg, new DemoHost());
  const run = { id: "r1" } as any;
  (engine as any).log(run, 0, '{"type":"x"}\n', "out");
  (engine as any).log(run, 0, "warn\n", "err");
  (engine as any).log(run, 0, "[loopsmith] hi\n");
  assert.deepEqual(engine.readLog("r1", 0), [{ s: "out", t: '{"type":"x"}\n' }, { s: "err", t: "warn\n" }, { s: "sys", t: "[loopsmith] hi\n" }]);
  fs.mkdirSync(path.join(repo, ".loopsmith/logs/old"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".loopsmith/logs/old/0.log"), "plain old log\n");
  assert.deepEqual(engine.readLog("old", 0), [{ s: "out", t: "plain old log\n" }]);
});

test("Markdown: indented headings and quotes render and never hang", () => {
  const html = renderToStaticMarkup(createElement(Markdown, { text: "  # Heading\n  > quote\ntext\n   ```\ncode\n   ```" }));
  assert.match(html, /<h1>Heading<\/h1>/);
  assert.match(html, /<blockquote>quote<\/blockquote>/);
  assert.match(html, /<pre><code>code<\/code><\/pre>/);
});

test("unterminated output: partial Codex text shows live; end() flushes the rest", () => {
  const f = new LogFormatter();
  f.push({ s: "err", t: "OpenAI Codex v1\n--------\nmodel: m\n--------\ncodex\nfinal ans" });
  assert.equal((f.blocks().at(-1) as any).text, "final ans");
  f.end();
  assert.equal((f.blocks().at(-1) as any).text, "final ans\n");
  // An unknown JSON event without a newline is hidden while it may still be arriving, then shown.
  const g = new LogFormatter();
  g.push({ s: "out", t: '{"type":"mystery"}' });
  assert.deepEqual(g.blocks(), []);
  g.end();
  assert.deepEqual(g.blocks(), [{ kind: "output", text: '{"type":"mystery"}\n' }]);
});

test("expanded Claude tool calls keep every argument", () => {
  const blocks = formatLog([{ s: "out", t: j({ type: "assistant", message: { content: [{ type: "tool_use", id: "t", name: "Bash", input: { command: "npm test", timeout: 600000, run_in_background: true } }] } }) }]);
  const tool = blocks[0] as Extract<Block, { kind: "tool" }>;
  assert.equal(tool.detail, "npm test");
  assert.match(tool.input!, /"timeout": 600000/);
  assert.match(tool.input!, /"run_in_background": true/);
});

test("live log events carry their chunk position, also after a restart", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ls-seq-"));
  const cfg = defaultConfig();
  const seen: number[] = [];
  const a = new Engine(repo, () => cfg, new DemoHost());
  a.on("log", (e) => seen.push(e.n));
  (a as any).log({ id: "r" }, 0, "x", "out");
  (a as any).log({ id: "r" }, 0, "y", "err");
  const b = new Engine(repo, () => cfg, new DemoHost());
  b.on("log", (e) => seen.push(e.n));
  (b as any).log({ id: "r" }, 0, "z", "out");
  assert.deepEqual(seen, [0, 1, 2]);
  assert.equal(b.readLog("r", 0).length, 3);
});

test("full Codex transcript: an error after the prompt is shown, not folded", () => {
  const t = [
    "OpenAI Codex v0.50.0", "--------", "model: gpt-9", "session id: 0199a1b2-c3d4", "--------",
    "user", "Review the PR.",
    `ERROR: {"detail":"The 'gpt-9' model is not supported when using Codex with a ChatGPT account."}`, "",
  ].join("\n");
  const blocks = formatLog([{ s: "err", t }]);
  assert.deepEqual(kinds(blocks), ["noise", "noise", "error"]);
  assert.match((blocks[2] as any).title, /model is not supported/);
  assert.deepEqual((blocks[1] as any).lines, ["Review the PR."]);
});

test("Codex section words inside command output and fenced agent text stay text", () => {
  const t = [
    "OpenAI Codex v0.50.0", "--------", "model: m", "--------",
    "exec", "bash -lc whoami in /tmp", " succeeded in 5ms:", "user", "exec", "done",
    "codex", "Run this:", "```", "codex", "```", "ok", "",
  ].join("\n");
  const blocks = formatLog([{ s: "err", t }]);
  assert.deepEqual(kinds(blocks), ["noise", "tool", "message"]);
  assert.equal((blocks[1] as any).result, "user\nexec\ndone\n");
  assert.match((blocks[2] as any).text, /```\ncodex\n```\nok/);
});

test("Codex --json command shows while running and completes in the same block", () => {
  const f = new LogFormatter();
  f.push({ s: "out", t: j({ type: "item.started", item: { id: "i1", type: "command_execution", command: "npm test", aggregated_output: "", exit_code: null, status: "in_progress" } }) });
  let b = f.blocks();
  assert.equal(b.length, 1);
  assert.equal((b[0] as any).summary, "npm test");
  assert.equal((b[0] as any).running, true);
  f.push({ s: "out", t: j({ type: "item.updated", item: { id: "i1", type: "command_execution", command: "npm test", aggregated_output: "3 passing", exit_code: null } }) });
  assert.equal((f.blocks()[0] as any).result, "3 passing");
  assert.equal((f.blocks()[0] as any).running, true);
  f.push({ s: "out", t: j({ type: "item.completed", item: { id: "i1", type: "command_execution", command: "npm test", aggregated_output: "ok\n", exit_code: 0, status: "completed" } }) });
  b = f.blocks();
  assert.equal(b.length, 1);
  assert.equal((b[0] as any).result, "ok\n");
  assert.equal((b[0] as any).error, false);
  assert.equal((b[0] as any).running, undefined);
});

const codexExec = (out: string[]) => ["OpenAI Codex v0.50.0", "--------", "model: m", "--------", "exec", "bash -lc 'cat x.json' in /tmp", " succeeded in 5ms:", ...out].join("\n");

test("JSON and odd words printed by a Codex command stay command output", () => {
  const out = ['{"type":"result","result":"fixture"}', '{"type":"assistant","message":{"content":{}}}', "constructor", "toString", "end", ""];
  const blocks = formatLog([{ s: "err", t: codexExec(out) }]);
  assert.deepEqual(kinds(blocks), ["noise", "tool"]);
  assert.equal((blocks[1] as any).result, out.join("\n"));
});

test("malformed structured events never throw; they show as text", () => {
  const t = j({ type: "assistant", message: { content: {} } }) + j({ type: "user", message: { content: "x" } }) + j({ type: "item.completed", item: null });
  assert.doesNotThrow(() => formatLog([{ s: "out", t }]));
});

test("partial Codex command output shows while it streams", () => {
  const f = new LogFormatter();
  f.push({ s: "err", t: codexExec(["line 1", "progress 40%"]) });
  assert.equal((f.blocks().at(-1) as any).result, "line 1\nprogress 40%");
});

test("events with wrongly typed fields show as text and every block renders", () => {
  const t =
    j({ type: "assistant", message: { content: [{ type: "text", text: { unexpected: "value" } }] } }) +
    j({ type: "assistant", message: { content: [{ type: "thinking", thinking: 5 }, { type: "tool_use", id: 1, name: {}, input: "x" }] } }) +
    j({ type: "result", result: { a: 1 } }) +
    j({ type: "item.completed", item: { type: "agent_message", text: ["x"] } });
  const blocks = formatLog([{ s: "out", t }]);
  for (const b of blocks) {
    for (const [k, v] of Object.entries(b)) if (v !== undefined && k !== "kind" && k !== "lines" && k !== "error" && k !== "running") assert.equal(typeof v, "string", `${b.kind}.${k}`);
    const text = "text" in b ? b.text : undefined;
    if (typeof text === "string") assert.doesNotThrow(() => renderToStaticMarkup(createElement(Markdown, { text })));
  }
  assert.ok(blocks.some((b) => b.kind === "output" && /unexpected/.test(b.text)), "invalid event shown as text");
});

test("a Codex CLI error during a command marks it failed and is shown", () => {
  const blocks = formatLog([{ s: "err", t: codexExec(["partial output"]).replace(" succeeded in 5ms:\n", "") + "\nERROR: connection lost\n" }]);
  const tool = blocks.find((b) => b.kind === "tool") as any;
  assert.equal(tool.error, true);
  assert.equal(blocks.at(-1)!.kind, "error");
  assert.equal((blocks.at(-1) as any).title, "connection lost");
});

test("partial JSON text inside a Codex message stays visible", () => {
  const f = new LogFormatter();
  f.push({ s: "err", t: "OpenAI Codex v1\n--------\nmodel: m\n--------\ncodex\n```json\n{\"a\": 1" });
  assert.match((f.blocks().at(-1) as any).text, /\{"a": 1$/);
});

test("FATAL and timestamped ERROR lines during a command fail it and are shown", () => {
  for (const line of ["FATAL: connection lost", "2026-01-01T00:00:00Z ERROR codex_core: connection lost"]) {
    const t = codexExec(["partial output"]).replace(" succeeded in 5ms:\n", "") + "\n" + line + "\n";
    const blocks = formatLog([{ s: "err", t }]);
    const tool = blocks.find((b) => b.kind === "tool") as any;
    assert.equal(tool.error, true, line);
    assert.equal(tool.running, undefined, line);
    assert.equal(blocks.at(-1)!.kind, "error", line);
    assert.match((blocks.at(-1) as any).title, /connection lost/);
  }
});

test("Codex --json: a failed status without an exit code is a failure", () => {
  const blocks = formatLog([{ s: "out", t: j({ type: "item.completed", item: { id: "c", type: "command_execution", command: "x", aggregated_output: "", exit_code: null, status: "failed" } }) }]);
  assert.equal((blocks[0] as any).error, true);
});

test("unsupported Claude content and unmatched tool results stay visible", () => {
  const t =
    j({ type: "assistant", message: { content: [{ type: "server_tool_use_v9", data: "keep-me-1" }] } }) +
    j({ type: "assistant", message: { content: "keep-me-2" } }) +
    j({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "nope", content: "keep-me-3" }] } }) +
    j({ type: "user", message: { content: ["keep-me-4"] } });
  const shown = JSON.stringify(formatLog([{ s: "out", t }]));
  for (const k of ["keep-me-1", "keep-me-2", "keep-me-3", "keep-me-4"]) assert.ok(shown.includes(k), k);
});

test("timestamped Codex errors after prompt and thinking headers are shown", () => {
  for (const header of ["user", "thinking"]) {
    const t = ["OpenAI Codex v1", "--------", "model: m", "--------", ...(header === "thinking" ? ["user", "p"] : []), header, "text", "2026-01-01T00:00:00Z ERROR codex_core: connection lost", ""].join("\n");
    const blocks = formatLog([{ s: "err", t }]);
    assert.equal(blocks.at(-1)!.kind, "error", header);
    assert.match((blocks.at(-1) as any).title, /connection lost/);
  }
});

test("an ERROR example inside a fenced Codex message stays part of the message", () => {
  const t = ["OpenAI Codex v1", "--------", "model: m", "--------", "codex", "Example:", "```", "ERROR: example failure", "```", "", "Next paragraph.", ""].join("\n");
  const blocks = formatLog([{ s: "err", t }]);
  assert.deepEqual(kinds(blocks), ["noise", "message"]);
  assert.match((blocks[1] as any).text, /```\nERROR: example failure\n```\n\nNext paragraph\./);
});

test("end(): a command without a status is marked stopped, not running or successful", () => {
  const f = new LogFormatter();
  f.push({ s: "err", t: codexExec(["partial"]).replace(" succeeded in 5ms:\n", "") + "\n" });
  f.end();
  const tool = f.blocks().find((b) => b.kind === "tool") as any;
  assert.equal(tool.running, undefined);
  assert.equal(tool.stopped, true);
  assert.notEqual(tool.error, false);
});
