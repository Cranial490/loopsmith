import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultConfig, validateConfig, type AgentStage, type ApprovalStage } from "../server/config.ts";
import { renameStage } from "../server/template.ts";

const renamed = (oldId: string, newId: string) => {
  const cfg = defaultConfig();
  const before = structuredClone(cfg);
  cfg.pipeline = renameStage(cfg.pipeline, oldId, newId);
  assert.deepEqual(validateConfig(cfg), []);
  assert.deepEqual(cfg.harnesses, before.harnesses);
  return { p: Object.fromEntries(cfg.pipeline.map((s) => [s.id, s])) as Record<string, any>, ids: cfg.pipeline.map((s) => s.id) };
};

test("rename implement updates continueFrom", () => {
  const { p, ids } = renamed("implement", "build");
  assert.deepEqual(ids, ["build", "review", "fix", "approve", "merge"]);
  assert.deepEqual((p.fix as AgentStage).continueFrom, ["build", "fix"]);
});

test("rename fix updates goto, continueFrom and sendBackTo", () => {
  const { p } = renamed("fix", "repair");
  assert.deepEqual(p.review.next.map((t: any) => t.goto), ["approve", "repair"]);
  assert.deepEqual((p.repair as AgentStage).continueFrom, ["implement", "repair"]);
  assert.equal((p.approve as ApprovalStage).sendBackTo, "repair");
});

test("rename review updates goto and output templates", () => {
  const { p } = renamed("review", "check");
  assert.deepEqual(p.fix.next, [{ goto: "check" }]);
  assert.match(p.fix.prompt, /\{\{stages\.check\.output\}\}/);
  assert.doesNotMatch(p.fix.prompt, /stages\.review/);
});

test("rename touches only the exact id, in every template kind", () => {
  const out = renameStage([
    { id: "fix", type: "agent", harness: "claude", prompt: "{{ stages.fix.output }} {{stages.fixup.output}} {{stages.fix.outputs}} fix", continueFrom: ["fixup", "fix"] },
    { id: "fixup", type: "shell", command: "echo {{  stages.fix.output}} {{stages.fixup.output}}", next: [{ goto: "fixup" }, { goto: "fix" }] },
    { id: "ok", type: "approval", message: "see {{stages.fix.output  }}", sendBackTo: "fixup" },
  ], "fix", "patch");
  assert.deepEqual(out, [
    { id: "patch", type: "agent", harness: "claude", prompt: "{{ stages.patch.output }} {{stages.fixup.output}} {{stages.fix.outputs}} fix", continueFrom: ["fixup", "patch"] },
    { id: "fixup", type: "shell", command: "echo {{  stages.patch.output}} {{stages.fixup.output}}", next: [{ goto: "fixup" }, { goto: "patch" }] },
    { id: "ok", type: "approval", message: "see {{stages.patch.output  }}", sendBackTo: "fixup" },
  ]);
});
