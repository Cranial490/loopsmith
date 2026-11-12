import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { defaultConfig, saveConfig, configPath } from "./config.js";
import { withNativeBlockers, type GitHost, type Issue } from "./github.js";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Make a throwaway git repo and a config whose harnesses are the fake agent. */
export function setupDemoRepo(): string {
  const repo = path.join(os.tmpdir(), "loopsmith-demo-repo");
  if (!fs.existsSync(path.join(repo, ".git"))) {
    fs.mkdirSync(repo, { recursive: true });
    const git = (...a: string[]) => execFileSync("git", a, { cwd: repo });
    git("init", "-q", "-b", "main");
    fs.writeFileSync(path.join(repo, "README.md"), "# demo\n");
    fs.writeFileSync(path.join(repo, ".gitignore"), ".loopsmith/\nloopsmith.config.json\n");
    git("add", ".");
    git("-c", "user.email=demo@example.com", "-c", "user.name=demo", "commit", "-qm", "init");
  }
  if (!fs.existsSync(configPath(repo))) {
    const cfg = defaultConfig();
    const fake = path.resolve(here, "../demo/fake-agent.mjs");
    for (const h of Object.values(cfg.harnesses)) {
      h.command = process.execPath;
      h.args = [fake, "{{prompt}}"];
      h.continueArgs = undefined;
      h.resumeArgs = [fake, "--resume", "{{sessionId}}", "{{prompt}}"];
      h.sessionIdPattern = "session id:\\s*(\\S+)";
      h.format = "text";
    }
    cfg.harnesses.claude.env = { FAKE_ASK: "1" }; // the fake implementer asks one question
    const merge = cfg.pipeline.find((s) => s.id === "merge");
    if (merge?.type === "shell") merge.command = `echo "(demo) gh pr merge {{pr.number}} --squash --delete-branch" && sleep 1`;
    saveConfig(repo, cfg);
  }
  return repo;
}

export class DemoHost implements GitHost {
  issues: Issue[] = [
    { number: 1, title: "Add order model and storage", labels: ["backend"] },
    { number: 2, title: "Create order API endpoint", labels: ["backend", "api"] },
    { number: 3, title: "Show order list in the dashboard", labels: ["frontend"] },
    { number: 4, title: "Send email when an order ships", labels: ["backend"] },
    { number: 5, title: "Export orders as CSV", labels: ["backend"] },
  ].map((i) => ({ ...i, body: `Demo issue body for #${i.number}.\n\n## Blocked by\n\n${i.number === 1 || i.number === 5 ? "None - can start immediately" : `- #${i.number - 1}`}\n`, url: `https://github.com/demo/repo/issues/${i.number}` }));

  /** Native "blocked by" links, as the GitHub dependencies endpoint returns them. #5 has no text blocker. */
  dependencies: Record<number, { number: number }[]> = { 5: [{ number: 2 }] };

  async listIssues() { return Promise.all(this.issues.map((i) => withNativeBlockers(i, async (n) => JSON.stringify(this.dependencies[n] ?? [])))); }
  async getIssue(n: number) { return (await this.listIssues()).find((i) => i.number === n)!; }
  async findPr(branch: string) {
    const n = Number(branch.match(/(\d+)$/)?.[1]);
    return n ? { number: 100 + n, url: `https://github.com/demo/repo/pull/${100 + n}` } : undefined;
  }
}
