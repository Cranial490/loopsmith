import fs from "node:fs";
import path from "node:path";

/** How to start one agent CLI. `{{prompt}}` and `{{outputFile}}` are replaced at run time. */
export interface HarnessConfig {
  label?: string;
  command: string;
  args: string[];
  /** Args to use when a stage asks to continue the previous session in the same worktree. */
  continueArgs?: string[];
  /** Args to continue one exact session. {{sessionId}} is the id saved from an earlier step. */
  resumeArgs?: string[];
  /** Regex (first group) that finds the session id in the CLI output. Not needed when args use {{newSessionId}}. */
  sessionIdPattern?: string;
  /**
   * "claude-stream-json" reads the final result, cost and token usage from Claude's JSON event stream.
   * "codex-json" reads token usage from `codex exec --json` events. "text" only finds Codex's `tokens used` total.
   */
  format?: "text" | "claude-stream-json" | "codex-json";
  env?: Record<string, string>;
}

/** Where to go after a stage. The first rule whose `when` is true (or has no `when`) wins. */
export interface Transition {
  when?: string; // e.g. "score >= 8"
  goto: string; // stage id, or "end"
}

interface BaseStage {
  id: string;
  name?: string;
  next?: Transition[];
  /** Stop the run (needs attention) if this stage would run more than this many times. */
  maxRuns?: number;
  timeoutMinutes?: number;
  /** Run the stage again this many times when it fails (crash, timeout, missing score). */
  retries?: number;
}

export interface AgentStage extends BaseStage {
  type: "agent";
  harness: string;
  prompt: string;
  continueSession?: boolean;
  /** With continueSession: only continue a session from one of these stages. Empty = any stage of this harness. */
  continueFrom?: string[];
  /** The agent may stop and ask you questions (not in hands-off mode). Default: true. */
  allowQuestions?: boolean;
  /** Fail this stage when no PR exists for the branch after it. */
  requirePr?: boolean;
  /** Fail this stage when an extract variable is not found. Default: true. */
  requireExtract?: boolean;
  /** Ask the agent to write a handoff note for the next agent. Default: true. */
  writeHandoff?: boolean;
  /** Put the handoff notes of earlier agents at the top of the prompt. Default: true. */
  readHandoff?: boolean;
  /** Variable name -> regex. The first capture group of the last match is stored in vars. */
  extract?: Record<string, string>;
}

export interface ShellStage extends BaseStage {
  type: "shell";
  command: string;
}

export interface ApprovalStage extends BaseStage {
  type: "approval";
  message?: string;
  /** Stage to run when you send the work back with notes. Default: the nearest agent stage above. */
  sendBackTo?: string;
}

export type Stage = AgentStage | ShellStage | ApprovalStage;

export interface Config {
  baseBranch: string;
  /** Folder for worktrees. Relative paths are relative to the repo. */
  worktreeDir: string;
  branchPrefix: string;
  maxParallel: number;
  removeWorktreeWhenDone: boolean;
  /** Bash command to run once in each new worktree (for example "npm ci"). */
  setupCommand: string;
  /** Untracked files or folders to copy from the repo into each new worktree (for example ".env"). */
  copyFiles: string[];
  /** A failed / interrupted / needs-attention run keeps its slot, so later issues do not start on top of a broken one. */
  holdQueueOnProblem: boolean;
  retryDelaySeconds: number;
  /** Added to the end of every agent prompt that writes a handoff note. {{handoffFile}} is the file path. */
  handoffInstructions: string;
  /** Added to agent prompts when the agent may ask you questions. {{questionFile}} is the file path. */
  questionInstructions: string;
  /** Max characters of earlier notes given to the next agent (newest notes are kept). */
  handoffMaxChars: number;
  harnesses: Record<string, HarnessConfig>;
  pipeline: Stage[];
}

const IMPLEMENT_PROMPT = `Implement GitHub issue #{{issue.number}} ("{{issue.title}}") using /tdd.

Issue body:
{{issue.body}}

Rules:
- You are in a git worktree on branch "{{branch}}". Commit to this branch only.
- Do not over-engineer. Keep it simple where you can.
- When the implementation is complete, push the branch and raise a PR from "{{branch}}" into "{{baseBranch}}" that closes #{{issue.number}}.
- Update the Linear ticket and move it to In Progress.
- Use simple language and ASD STE100 style in the PR description and comments.
- Write the assumptions you made in the PR description under "Assumptions".
- At the end, output a short summary of what you implemented in simple language.`;

const REVIEW_PROMPT = `Review PR #{{pr.number}} (branch "{{branch}}", issue #{{issue.number}}). Look for inconsistencies, bugs and any major architecture blunders.
This is review round {{iteration}}.

Report the issues in a clear manner. For each issue give: severity (major/minor), the problem, a suggested fix, and the reason for that fix.
Use simple language in ASD STE100 style. Do not change any code.

Rate the implementation out of 10. On the very last line write exactly:
SCORE: <number>/10`;

const FIX_PROMPT = `A reviewer looked at PR #{{pr.number}} and gave it {{vars.score}}/10. Here is the review:

{{stages.review.output}}

Fix all the major issues. Fix minor issues when the fix is small and safe. Keep it simple. Do not over-engineer.
Commit and push to branch "{{branch}}" (the same PR). Then output a short summary of what you changed.`;

const HANDOFF_INSTRUCTIONS = `---
HANDOFF NOTE (required)
Another agent continues after you. It cannot see your conversation. Before you finish, write a short handoff note (max 300 words) to this file:
{{handoffFile}}

Use this format, in simple language:
## What I did
## Decisions and why
## Not done / open problems
## Instructions for the next agent
Do not commit this file. It is outside the repo.`;

const QUESTION_INSTRUCTIONS = `---
QUESTIONS FOR THE HUMAN (optional)
A human can answer questions. Ask when the answer changes what you build and you cannot find it in the issue, the code or the notes. For small things, choose the simplest option and record it as an assumption.
To ask: write your questions as a numbered list to the file below. For each question, give the options you see and the one you recommend. Then stop at once: do not continue the work, and do not write the handoff note.
{{questionFile}}
You get the answers later in this same session, and then you continue.`;

export const NO_QUESTIONS = `---
No human is available. Do not ask questions. If something is unclear, make the simplest reasonable choice and record it as an assumption.`;

const CLAUDE_FLAGS = ["--dangerously-skip-permissions", "--output-format", "stream-json", "--verbose"];
const CODEX_FLAGS = ["--json", "--dangerously-bypass-approvals-and-sandbox", "--output-last-message", "{{outputFile}}"];
const OLD_CODEX_FLAGS = CODEX_FLAGS.slice(1); // before --json; old saved configs are upgraded

export function defaultConfig(): Config {
  return {
    baseBranch: "main",
    worktreeDir: "../.loopsmith-worktrees",
    branchPrefix: "loop/issue-",
    maxParallel: 1,
    removeWorktreeWhenDone: true,
    setupCommand: "",
    copyFiles: [".env"],
    holdQueueOnProblem: true,
    retryDelaySeconds: 30,
    handoffInstructions: HANDOFF_INSTRUCTIONS,
    questionInstructions: QUESTION_INSTRUCTIONS,
    handoffMaxChars: 12000,
    harnesses: {
      claude: {
        label: "Claude Code",
        command: "claude",
        args: ["-p", "{{prompt}}", ...CLAUDE_FLAGS],
        resumeArgs: ["-p", "{{prompt}}", "--resume", "{{sessionId}}", ...CLAUDE_FLAGS],
        continueArgs: ["-c", "-p", "{{prompt}}", ...CLAUDE_FLAGS],
        sessionIdPattern: '"session_id":\\s*"([^"]+)"',
        format: "claude-stream-json",
      },
      codex: {
        label: "Codex CLI",
        command: "codex",
        args: ["exec", ...CODEX_FLAGS, "{{prompt}}"],
        resumeArgs: ["exec", ...CODEX_FLAGS, "resume", "{{sessionId}}", "{{prompt}}"],
        continueArgs: ["exec", ...CODEX_FLAGS, "resume", "--last", "{{prompt}}"],
        sessionIdPattern: '(?:session id:\\s*|"thread_id":\\s*")([0-9a-fA-F-]{8,})',
        format: "codex-json",
      },
      pi: {
        label: "Pi",
        command: "pi",
        args: ["-p", "--session-id", "{{newSessionId}}", "{{prompt}}"],
        resumeArgs: ["-p", "--session", "{{sessionId}}", "{{prompt}}"],
        continueArgs: ["-c", "-p", "{{prompt}}"],
      },
    },
    pipeline: [
      { id: "implement", name: "Implement (TDD)", type: "agent", harness: "claude", prompt: IMPLEMENT_PROMPT, maxRuns: 1, requirePr: true, timeoutMinutes: 90 },
      {
        id: "review",
        name: "AI review",
        type: "agent",
        harness: "codex",
        prompt: REVIEW_PROMPT,
        extract: { score: "SCORE:\\s*(\\d+(?:\\.\\d+)?)\\s*/\\s*10" },
        next: [
          { when: "score >= 8", goto: "approve" },
          { goto: "fix" },
        ],
        maxRuns: 5,
        retries: 1,
        timeoutMinutes: 30,
      },
      { id: "fix", name: "Fix review issues", type: "agent", harness: "claude", prompt: FIX_PROMPT, continueSession: true, continueFrom: ["implement", "fix"], next: [{ goto: "review" }], maxRuns: 4, timeoutMinutes: 60 },
      { id: "approve", name: "Human approval", type: "approval", message: "Review score reached the target. Check the PR (e.g. with /stage-chapters), then approve the merge.", sendBackTo: "fix" },
      { id: "merge", name: "Merge PR", type: "shell", command: "gh pr merge {{pr.number}} --squash && (git push origin --delete {{branch}} 2>/dev/null || true)" },
    ],
  };
}

export function configPath(repo: string) {
  return path.join(repo, "loopsmith.config.json");
}

export function loadConfig(repo: string): Config {
  const p = configPath(repo);
  if (!fs.existsSync(p)) {
    const cfg = defaultConfig();
    fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
    return cfg;
  }
  const def = defaultConfig();
  const cfg = { ...def, ...JSON.parse(fs.readFileSync(p, "utf8")) } as Config;
  // Older config files: give the built-in harnesses the exact-session settings.
  for (const [id, h] of Object.entries(cfg.harnesses ?? {})) {
    const d = def.harnesses[id];
    if (d && h.command === d.command && !h.resumeArgs && JSON.stringify(h.args) === JSON.stringify(legacyArgs(id))) {
      Object.assign(h, { args: d.args, resumeArgs: d.resumeArgs, continueArgs: d.continueArgs, sessionIdPattern: d.sessionIdPattern, format: d.format });
    }
    // The Codex defaults from before --json (token usage needs the JSON events).
    if (id === "codex" && d && h.command === d.command && (h.format ?? "text") === "text" && JSON.stringify(h.args) === JSON.stringify(["exec", ...OLD_CODEX_FLAGS, "{{prompt}}"])
      && JSON.stringify(h.resumeArgs) === JSON.stringify(["exec", ...OLD_CODEX_FLAGS, "resume", "{{sessionId}}", "{{prompt}}"])) {
      Object.assign(h, { args: d.args, resumeArgs: d.resumeArgs, continueArgs: d.continueArgs, sessionIdPattern: d.sessionIdPattern, format: d.format });
    }
  }
  const errors = validateConfig(cfg);
  if (errors.length) throw new Error(`Invalid ${p}:\n- ${errors.join("\n- ")}`);
  return cfg;
}

function legacyArgs(id: string): string[] | undefined {
  if (id === "claude") return ["-p", "{{prompt}}", ...CLAUDE_FLAGS];
  if (id === "codex") return ["exec", ...OLD_CODEX_FLAGS, "{{prompt}}"];
  if (id === "pi") return ["-p", "{{prompt}}"];
}

export function saveConfig(repo: string, cfg: Config) {
  fs.writeFileSync(configPath(repo), JSON.stringify(cfg, null, 2));
}

export function validateConfig(cfg: Config): string[] {
  const errors: string[] = [];
  if (!Array.isArray(cfg.pipeline) || cfg.pipeline.length === 0) errors.push("pipeline must have at least one stage");
  const ids = new Set<string>();
  for (const s of cfg.pipeline ?? []) {
    if (!s.id || !/^[a-zA-Z0-9_-]+$/.test(s.id)) errors.push(`stage id "${s.id}" must use letters, numbers, - or _`);
    if (ids.has(s.id)) errors.push(`duplicate stage id "${s.id}"`);
    ids.add(s.id);
    if (!["agent", "shell", "approval"].includes(s.type)) errors.push(`stage "${s.id}": unknown type "${(s as any).type}"`);
    if (s.type === "agent") {
      if (!cfg.harnesses?.[s.harness]) errors.push(`stage "${s.id}": unknown harness "${s.harness}"`);
      if (!s.prompt?.trim()) errors.push(`stage "${s.id}": prompt is empty`);
      for (const [k, re] of Object.entries(s.extract ?? {})) {
        try { new RegExp(re); } catch { errors.push(`stage "${s.id}": extract "${k}" is not a valid regex`); }
      }
    }
    if (s.type === "shell" && !s.command?.trim()) errors.push(`stage "${s.id}": command is empty`);
  }
  for (const s of cfg.pipeline ?? []) {
    if (s.type === "approval" && s.sendBackTo && !ids.has(s.sendBackTo)) errors.push(`stage "${s.id}": sendBackTo "${s.sendBackTo}" does not exist`);
    if (s.type === "agent") for (const c of s.continueFrom ?? []) if (!ids.has(c)) errors.push(`stage "${s.id}": continueFrom "${c}" does not exist`);
    for (const t of s.next ?? []) {
      if (t.goto !== "end" && !ids.has(t.goto)) errors.push(`stage "${s.id}": goto "${t.goto}" does not exist`);
    }
  }
  for (const [name, h] of Object.entries(cfg.harnesses ?? {})) {
    if (!h.command) errors.push(`harness "${name}": command is empty`);
    if (!Array.isArray(h.args)) errors.push(`harness "${name}": args must be a list`);
    if (h.sessionIdPattern) { try { new RegExp(h.sessionIdPattern); } catch { errors.push(`harness "${name}": sessionIdPattern is not a valid regex`); } }
  }
  if (!(cfg.maxParallel >= 1)) errors.push("maxParallel must be 1 or more");
  return errors;
}
