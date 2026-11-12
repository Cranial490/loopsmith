import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { NO_QUESTIONS } from "./config.js";
import type { Config, Stage, AgentStage, ShellStage, ApprovalStage } from "./config.js";
import type { GitHost, Issue } from "./github.js";
import { ensureWorktree, removeWorktree, deleteBranch } from "./git.js";
import { render, renderShell, evalCondition, extractVars } from "./template.js";
import { startProc, type RunningProc } from "./proc.js";
import { StreamParser, usageSince, type TokenUsage } from "./streams.js";

export type RunStatus = "queued" | "running" | "waiting_approval" | "waiting_input" | "done" | "failed" | "stopped" | "needs_attention" | "interrupted";
export type StepStatus = "running" | "done" | "failed" | "waiting" | "asked" | "skipped" | "stopped";

export interface Step {
  index: number;
  stageId: string;
  stageName: string;
  type: Stage["type"];
  attempt: number;
  status: StepStatus;
  startedAt: string;
  endedAt?: string;
  harness?: string;
  prompt?: string;
  command?: string;
  exitCode?: number | null;
  output?: string;
  vars?: Record<string, string | number>;
  note?: string;
  /** The handoff note this step wrote for the next agent. */
  handoff?: string;
  /** The agent CLI session of this step. A later stage can continue exactly this session. */
  sessionId?: string;
  costUsd?: number;
  /** Tokens this step used (see TokenUsage). Missing = the CLI reported none (or not yet). */
  usage?: TokenUsage;
  /** The CLI's running total for its whole session at the end of this step, when it reports one (Codex). */
  sessionUsage?: TokenUsage;
  /** The agent stopped here to ask you this. */
  question?: string;
  answer?: string;
}

export interface LogChunk { s: "out" | "err" | "sys"; t: string }

export interface HandoffNote {
  stepIndex: number;
  stageId: string;
  stageName: string;
  attempt: number;
  harness?: string;
  note: string;
  at: string;
}

export interface Run {
  id: string;
  /** Queue order. */
  seq: number;
  issue: Issue;
  status: RunStatus;
  options: { autoApprove: boolean };
  branch: string;
  worktree: string;
  pr?: { number: number; url: string };
  vars: Record<string, string | number>;
  outputs: Record<string, string>;
  /** Notes agents (and you) leave for the agents after them, oldest first. */
  handoffs: HandoffNote[];
  steps: Step[];
  currentStageId?: string;
  pipeline: Stage[]; // snapshot, so config edits never break a running loop
  /** Issues that must be done first (from "Blocked by" in the issue body). */
  blockedBy: number[];
  /** Index of the step whose question you just answered. The next step continues that session. */
  pendingAnswer?: number;
  /** Your last "send back" notes. */
  feedback?: string;
  /** Set by approve / resume / send back: you asked for this run, so it goes first. */
  resumed?: boolean;
  error?: string;
  /** Steps before this index do not count toward maxRuns. */
  limitOffset?: number;
  createdAt: string;
  updatedAt: string;
}

const MAX_OUTPUT = 30_000;
const PROBLEM: RunStatus[] = ["failed", "needs_attention", "interrupted"];

export class Engine extends EventEmitter {
  runs = new Map<string, Run>();
  private procs = new Map<string, RunningProc>();
  private active = new Set<string>();
  private dataDir: string;
  private seq = 0;

  constructor(public repo: string, public getConfig: () => Config, public host: GitHost) {
    super();
    this.dataDir = path.join(repo, ".loopsmith");
    fs.mkdirSync(path.join(this.dataDir, "runs"), { recursive: true });
    fs.writeFileSync(path.join(this.dataDir, ".gitignore"), "*\n");
    this.load();
    setImmediate(() => this.pump()); // runs that were queued before a restart start again
  }

  // ---------- persistence ----------
  private load() {
    const dir = path.join(this.dataDir, "runs");
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      let run: Run;
      try { run = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch { continue; } // half-written file
      run.handoffs ??= [];
      run.blockedBy ??= [];
      run.seq ??= new Date(run.createdAt).getTime();
      if (run.status === "running") {
        run.status = "interrupted";
        const last = run.steps.at(-1);
        if (last?.status === "running") { last.status = "stopped"; last.note = "loopsmith was restarted"; }
      }
      this.seq = Math.max(this.seq, run.seq);
      this.runs.set(run.id, run);
    }
  }

  private save(run: Run) {
    run.updatedAt = new Date().toISOString();
    // Write to a temp file first, so a crash never leaves a broken run file.
    const p = path.join(this.dataDir, "runs", `${run.id}.json`);
    fs.writeFileSync(p + ".tmp", JSON.stringify(run, null, 2));
    fs.renameSync(p + ".tmp", p);
    this.emit("run", run);
  }

  /**
   * A step log: the original stdout ("out"), stderr ("err") and Loopsmith's own lines ("sys"),
   * one JSON chunk per line. The UI formats it; the raw view shows it unchanged.
   */
  readLog(runId: string, index: number): LogChunk[] {
    const dir = path.join(this.dataDir, "logs", runId);
    const p = path.join(dir, `${index}.jsonl`);
    if (fs.existsSync(p)) return fs.readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    // Logs saved by older versions are plain text.
    const old = path.join(dir, `${index}.log`);
    return fs.existsSync(old) ? [{ s: "out", t: fs.readFileSync(old, "utf8") }] : [];
  }

  /** Chunks written per log file, so live events carry their position (`n`) and clients can spot gaps. */
  private logCounts = new Map<string, number>();

  private log(run: Run, index: number, text: string, s: LogChunk["s"] = "sys") {
    if (!text) return;
    const p = path.join(this.dataDir, "logs", run.id, `${index}.jsonl`);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const n = this.logCounts.get(p) ?? (fs.existsSync(p) ? fs.readFileSync(p, "utf8").split("\n").length - 1 : 0);
    fs.appendFileSync(p, JSON.stringify({ s, t: text }) + "\n");
    this.logCounts.set(p, n + 1);
    this.emit("log", { runId: run.id, index, s, t: text, n });
  }

  // ---------- public actions ----------
  enqueue(issues: Issue[], options: Run["options"]): Run[] {
    const cfg = this.getConfig();
    const created: Run[] = [];
    for (const issue of orderByBlockers(issues)) {
      const busy = [...this.runs.values()].find((r) => r.issue.number === issue.number && !["done", "stopped"].includes(r.status));
      if (busy) continue;
      const run: Run = {
        id: randomUUID().slice(0, 8),
        seq: ++this.seq,
        issue,
        status: "queued",
        options,
        branch: `${cfg.branchPrefix}${issue.number}`,
        worktree: path.resolve(this.repo, cfg.worktreeDir, `issue-${issue.number}`),
        vars: {},
        outputs: {},
        handoffs: [],
        steps: [],
        pipeline: structuredClone(cfg.pipeline),
        blockedBy: issue.blockedBy ?? [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      this.runs.set(run.id, run);
      this.save(run);
      created.push(run);
    }
    this.pump();
    return created;
  }

  approve(id: string) {
    const { run, step } = this.waitingStep(id);
    step.status = "done";
    step.endedAt = new Date().toISOString();
    step.note = "approved by you";
    run.currentStageId = this.nextStageId(run, this.stage(run, step.stageId));
    this.requeue(run);
  }

  reject(id: string) {
    const { run, step } = this.waitingStep(id);
    step.status = "failed";
    step.endedAt = new Date().toISOString();
    step.note = "rejected by you";
    run.status = "stopped";
    this.save(run);
    this.pump();
  }

  /** Not good enough yet: give your notes to an agent stage, then the loop continues from there. */
  sendBack(id: string, notes: string) {
    const { run, step } = this.waitingStep(id);
    if (!notes?.trim()) throw new Error("Write what must change");
    const stage = this.stage(run, step.stageId) as ApprovalStage;
    const i = run.pipeline.findIndex((s) => s.id === stage.id);
    const target = stage.sendBackTo ?? run.pipeline.slice(0, i).reverse().find((s) => s.type === "agent")?.id;
    if (!target) throw new Error("No agent stage to send this back to. Set sendBackTo on the approval stage.");
    step.status = "stopped";
    step.endedAt = new Date().toISOString();
    step.note = `sent back by you to "${target}"`;
    run.feedback = notes.trim();
    run.handoffs.push({
      stepIndex: step.index, stageId: stage.id, stageName: "You (the human reviewer)", attempt: step.attempt, at: new Date().toISOString(),
      note: `The human owner looked at the PR and did not approve it yet. Do what this note says. It is more important than older notes and reviews.\n\n${run.feedback}`,
    });
    this.log(run, step.index, `\nSent back with notes:\n${run.feedback}\n`);
    run.limitOffset = run.steps.length;
    run.currentStageId = target;
    this.requeue(run);
  }

  /** Answer the questions an agent asked. The same stage runs again and continues the agent's session. */
  answer(id: string, text: string) {
    const run = this.must(id);
    const step = run.steps.at(-1);
    if (run.status !== "waiting_input" || !step?.question) throw new Error("Run is not waiting for an answer");
    if (!text?.trim()) throw new Error("Write an answer");
    step.answer = text.trim();
    step.status = "asked";
    step.endedAt = new Date().toISOString();
    run.pendingAnswer = step.index;
    // Later agents (reviewer, fixer) must know what you decided.
    run.handoffs.push({
      stepIndex: step.index, stageId: step.stageId, stageName: `${step.stageName}: questions answered by the human`, attempt: step.attempt, at: new Date().toISOString(),
      note: `Questions:\n${step.question}\n\nAnswers from the human owner (these are decisions, follow them):\n${step.answer}`,
    });
    this.log(run, step.index, `\nYour answer:\n${step.answer}\n`);
    this.requeue(run);
  }

  stop(id: string) {
    const run = this.must(id);
    run.status = "stopped";
    const last = run.steps.at(-1);
    if (last?.status === "waiting") { last.status = "stopped"; last.endedAt = new Date().toISOString(); }
    this.procs.get(id)?.kill();
    this.save(run);
    this.pump();
  }

  /** Start again at the current stage, or at `fromStage`. */
  resume(id: string, opts: { resetLimits?: boolean; fromStage?: string } = {}) {
    const run = this.must(id);
    if (["running", "queued"].includes(run.status)) return;
    if (opts.fromStage) { this.stage(run, opts.fromStage); run.currentStageId = opts.fromStage; }
    if (opts.resetLimits || opts.fromStage) run.limitOffset = run.steps.length;
    const last = run.steps.at(-1);
    if (last?.status === "waiting") { last.status = "stopped"; last.endedAt = new Date().toISOString(); }
    this.requeue(run);
  }

  remove(id: string) {
    const run = this.must(id);
    if (this.active.has(id)) throw new Error("Stop the run first");
    this.runs.delete(id);
    fs.rmSync(path.join(this.dataDir, "runs", `${id}.json`), { force: true });
    fs.rmSync(path.join(this.dataDir, "logs", id), { recursive: true, force: true });
    fs.rmSync(path.join(this.dataDir, "handoff", id), { recursive: true, force: true });
    fs.rmSync(path.join(this.dataDir, "questions", id), { recursive: true, force: true });
    this.emit("removed", run.id);
    this.pump();
  }

  /** Called when loopsmith exits: stop the agents, so none keeps working with nobody watching. */
  shutdown() {
    for (const [id, proc] of this.procs) {
      proc.kill();
      const run = this.runs.get(id);
      if (!run) continue;
      run.status = "interrupted";
      const last = run.steps.at(-1);
      if (last?.status === "running") { last.status = "stopped"; last.note = "loopsmith was closed"; last.endedAt = new Date().toISOString(); }
      this.save(run);
    }
  }

  /** Issue numbers this queued run still waits for. */
  waitingFor(run: Run): number[] {
    return run.blockedBy.filter((n) => {
      const latest = [...this.runs.values()].filter((r) => r.issue.number === n).sort((a, b) => b.seq - a.seq)[0];
      return latest && latest.status !== "done";
    });
  }

  // ---------- scheduler ----------
  private requeue(run: Run) {
    run.error = undefined;
    run.resumed = true;
    run.status = "queued";
    this.save(run);
    this.pump();
  }

  private pump() {
    const cfg = this.getConfig();
    const max = Math.max(1, cfg.maxParallel);
    const all = [...this.runs.values()];
    // These runs keep their slot. With maxParallel = 1 the next issue starts only
    // after this one is merged, so it never builds on unmerged or broken work.
    const held = all.filter((r) => r.status === "waiting_approval" || r.status === "waiting_input" || (cfg.holdQueueOnProblem !== false && PROBLEM.includes(r.status))).length;
    const queued = all.filter((r) => r.status === "queued").sort((a, b) => Number(!!b.resumed) - Number(!!a.resumed) || a.seq - b.seq);
    for (const run of queued) {
      if (this.active.has(run.id)) continue; // its old process is still closing
      if (this.active.size >= max) break;
      if (!run.resumed && (this.active.size + held >= max || this.waitingFor(run).length)) continue;
      this.active.add(run.id);
      this.drive(run)
        .catch((err) => {
          run.status = "failed";
          run.error = String(err?.message ?? err);
          const last = run.steps.at(-1);
          if (last?.status === "running") { last.status = "failed"; last.endedAt = new Date().toISOString(); }
          this.save(run);
        })
        .finally(() => {
          this.active.delete(run.id);
          this.procs.delete(run.id);
          this.pump();
        });
    }
  }

  private async drive(run: Run) {
    run.status = "running";
    run.resumed = false;
    run.error = undefined;
    this.save(run);
    const cfg = this.getConfig();

    if (!run.issue.body) {
      try { run.issue = { ...run.issue, ...(await this.host.getIssue(run.issue.number)) }; } catch {}
    }

    let stageId: string | undefined = run.currentStageId ?? run.pipeline[0]?.id;
    while (stageId && stageId !== "end") {
      if (run.status !== "running") return;
      const stage = this.stage(run, stageId);
      run.currentStageId = stage.id;

      const visits = run.steps.slice(run.limitOffset ?? 0).filter((s) => s.stageId === stage.id && s.status === "done").length;
      if (stage.maxRuns && visits >= stage.maxRuns) {
        run.status = "needs_attention";
        run.error = `"${stage.name ?? stage.id}" already ran ${visits} time(s), which is its limit. Check the PR, then resume (limits reset) or stop.`;
        this.save(run);
        return;
      }

      const step: Step = {
        index: run.steps.length,
        stageId: stage.id,
        stageName: stage.name ?? stage.id,
        type: stage.type,
        attempt: run.steps.filter((s) => s.stageId === stage.id).length + 1,
        status: "running",
        startedAt: new Date().toISOString(),
      };
      run.steps.push(step);
      this.save(run);

      let result: "ok" | "fail" | "wait" | "ask";
      try {
        await this.prepareWorktree(run, step, cfg);
        result = await this.execStage(run, stage, step, cfg);
      } catch (e: any) {
        this.log(run, step.index, `\n[loopsmith] ${e.message}\n`);
        step.status = "failed";
        step.note = String(e.message).split("\n")[0].slice(0, 300);
        result = "fail";
      }
      if (step.status !== "waiting") step.endedAt = new Date().toISOString();

      if (result === "wait") { run.status = "waiting_approval"; this.save(run); return; }
      if (result === "ask" && run.status === "running") { run.status = "waiting_input"; this.save(run); return; }
      if (run.status !== "running") { if (step.status === "running") step.status = "stopped"; this.save(run); return; }

      if (result === "ok") {
        await this.refreshPr(run, step);
        if (stage.type === "agent" && stage.requirePr && !run.pr) {
          step.status = "failed";
          step.note = `no PR found for branch "${run.branch}"`;
          this.log(run, step.index, `\n[loopsmith] The stage finished, but there is no PR for branch "${run.branch}". The next stages need one.\n`);
          result = "fail";
        }
      }

      if (result === "fail") {
        let failsInRow = 0;
        for (let i = run.steps.length - 1; i >= 0 && run.steps[i].stageId === stage.id && run.steps[i].status === "failed"; i--) failsInRow++;
        if (failsInRow <= (stage.retries ?? 0)) {
          const wait = cfg.retryDelaySeconds ?? 30;
          this.log(run, step.index, `\n[loopsmith] will try this stage again in ${wait}s (retry ${failsInRow} of ${stage.retries})\n`);
          this.save(run);
          await this.sleep(run, wait * 1000);
          continue;
        }
        run.status = "failed";
        run.error = `"${step.stageName}" failed: ${step.note ?? `exit code ${step.exitCode}`}. Open the log, then resume to try this stage again.`;
        this.save(run);
        return;
      }

      stageId = this.nextStageId(run, stage);
      run.currentStageId = stageId;
      this.save(run);
    }

    run.status = "done";
    run.currentStageId = undefined;
    this.save(run);
    if (cfg.removeWorktreeWhenDone) {
      await removeWorktree(this.repo, run.worktree);
      try {
        const pr = await this.host.findPr(run.branch);
        if (pr?.state === "MERGED") await deleteBranch(this.repo, run.branch);
      } catch {}
    }
  }

  private async sleep(run: Run, ms: number) {
    const end = Date.now() + ms;
    while (Date.now() < end && run.status === "running") await new Promise((r) => setTimeout(r, Math.min(250, ms)));
  }

  /** Make the worktree when it does not exist: copy untracked files (.env) and run the setup command. */
  private async prepareWorktree(run: Run, step: Step, cfg: Config) {
    if (fs.existsSync(path.join(run.worktree, ".git"))) return;
    const log = (s: string) => this.log(run, step.index, s);
    await ensureWorktree(this.repo, run.worktree, run.branch, cfg.baseBranch, log);
    for (const f of cfg.copyFiles ?? []) {
      const src = path.resolve(this.repo, f), dst = path.resolve(run.worktree, f);
      if (!src.startsWith(this.repo + path.sep) || !fs.existsSync(src) || fs.existsSync(dst)) continue;
      fs.cpSync(src, dst, { recursive: true });
      log(`copied ${f} into the worktree\n`);
    }
    if (cfg.setupCommand?.trim()) {
      log(`$ ${cfg.setupCommand}\n`);
      const proc = startProc({ command: "bash", args: ["-lc", cfg.setupCommand], cwd: run.worktree, timeoutMs: 20 * 60_000, onStdout: (c) => this.log(run, step.index, c, "out"), onStderr: (c) => this.log(run, step.index, c, "err") });
      this.procs.set(run.id, proc);
      const res = await proc.done;
      this.procs.delete(run.id);
      if (res.code !== 0) throw new Error(`setup command failed (exit code ${res.code})`);
    }
    log("\n");
  }

  private async execStage(run: Run, stage: Stage, step: Step, cfg: Config): Promise<"ok" | "fail" | "wait" | "ask"> {
    if (stage.type === "approval") {
      const ctx = this.context(run, step, cfg);
      if (run.options.autoApprove) {
        step.status = "skipped";
        step.note = "auto-approved (hands-off mode)";
        this.log(run, step.index, "Auto-approved because hands-off mode is on.\n");
        return "ok";
      }
      step.status = "waiting";
      step.note = render(stage.message ?? "Waiting for your approval.", ctx);
      this.log(run, step.index, step.note + "\n");
      return "wait";
    }

    let command: string, args: string[], format = "text", env: Record<string, string> | undefined;
    let outputFile: string | undefined;
    let handoffFile: string | undefined;
    let questionFile: string | undefined;
    let sessionId: string | undefined; // known before the run (new id we chose, or the one we resume)
    let sessionPattern: string | undefined;

    if (stage.type === "agent") {
      const s = stage as AgentStage;
      const h = cfg.harnesses[s.harness];
      if (!h) throw new Error(`Unknown harness "${s.harness}"`);
      // Forget old values, so a review with no score can never pass on the score of an older round.
      for (const k of Object.keys(s.extract ?? {})) delete run.vars[k];
      const ctx = this.context(run, step, cfg);

      const asked = run.pendingAnswer !== undefined ? run.steps[run.pendingAnswer] : undefined;
      run.pendingAnswer = undefined;
      const answered = asked?.stageId === stage.id && asked.answer ? asked : undefined;
      const qa = answered ? `Your questions:\n${answered.question}\n\nAnswers from the human:\n${answered.answer}` : "";
      const canResume = !!answered && answered.harness === s.harness && ((!!answered.sessionId && !!h.resumeArgs) || !!h.continueArgs);

      let prompt: string;
      if (canResume) {
        // Same session: the agent still knows the task. It only needs the answers.
        prompt = `The human answered your questions.\n\n${qa}\n\nContinue the task from where you stopped.`;
      } else {
        prompt = render(s.prompt, ctx);
        if (s.readHandoff !== false && run.handoffs.length && !s.prompt.includes("{{handoff}}")) {
          prompt = `${ctx.handoff}\n\n## Your task\n\n${prompt}`;
        }
        if (answered) prompt += `\n\n---\nYou started this task before in this worktree and stopped to ask questions. Check \`git status\` and \`git log\` to see your earlier work, then continue.\n\n${qa}`;
      }
      if (s.allowQuestions !== false && !run.options.autoApprove) {
        questionFile = path.join(this.dataDir, "questions", run.id, `${step.index}.md`);
        fs.mkdirSync(path.dirname(questionFile), { recursive: true });
        fs.rmSync(questionFile, { force: true });
        prompt += "\n\n" + render(cfg.questionInstructions ?? "", { ...ctx, questionFile });
      } else {
        prompt += "\n\n" + NO_QUESTIONS;
      }
      if (s.writeHandoff !== false) {
        handoffFile = path.join(this.dataDir, "handoff", run.id, `${step.index}.md`);
        fs.mkdirSync(path.dirname(handoffFile), { recursive: true });
        fs.rmSync(handoffFile, { force: true });
        prompt += "\n\n" + render(cfg.handoffInstructions, { ...ctx, handoffFile });
      }
      outputFile = path.join(os.tmpdir(), `loopsmith-${run.id}-${step.index}.txt`);

      // Which session to continue: the one that asked the question, or else the newest
      // finished step of the same harness (from the allowed stages).
      const prev = canResume
        ? answered
        : s.continueSession
          ? [...run.steps].reverse().find((x) => x.index < step.index && x.status === "done" && x.harness === s.harness && (!s.continueFrom?.length || s.continueFrom.includes(x.stageId)))
          : undefined;
      const newSessionId = randomUUID();
      let template = h.args;
      if (prev?.sessionId && h.resumeArgs) {
        template = h.resumeArgs;
        sessionId = prev.sessionId;
        this.log(run, step.index, `[loopsmith] continues session ${prev.sessionId} of "${prev.stageName}"\n`);
      } else if (prev && h.continueArgs) {
        template = h.continueArgs;
        this.log(run, step.index, `[loopsmith] continues the most recent ${s.harness} session in this worktree\n`);
      } else if (template.some((a) => a.includes("{{newSessionId}}"))) {
        sessionId = newSessionId;
      }
      sessionPattern = h.sessionIdPattern;
      command = h.command;
      args = template.map((a) => (a === "{{prompt}}" ? prompt : render(a, { ...ctx, prompt, outputFile, handoffFile, sessionId: prev?.sessionId, newSessionId })));
      format = h.format ?? "text";
      env = h.env;
      step.harness = s.harness;
      step.prompt = prompt;
    } else {
      command = "bash";
      args = ["-lc", renderShell((stage as ShellStage).command, this.context(run, step, cfg))];
    }
    step.command = [command, ...args.map((a) => (a === step.prompt ? "<prompt>" : a))].join(" ");
    this.log(run, step.index, `$ ${step.command}\n\n`);
    this.save(run);

    const parser = format === "claude-stream-json" ? new StreamParser() : undefined;
    // Usage can be on either stream (Codex text prints its footer on stderr).
    const usageOut = stage.type === "agent" ? parser ?? new StreamParser(format) : undefined;
    const usageErr = stage.type === "agent" ? new StreamParser(format) : undefined;
    const liveUsage = () => {
      const u = usageOut?.usage ?? usageErr?.usage;
      if (u && u !== step.usage) { step.usage = u; this.save(run); }
    };
    let raw = "";
    const keep = (c: string) => { if (raw.length < 300_000) raw += c; };
    const proc = startProc({
      command,
      args,
      cwd: run.worktree,
      env: { ...env, LOOPSMITH_RUN: run.id, LOOPSMITH_ISSUE: String(run.issue.number), LOOPSMITH_STAGE: stage.id, ...(handoffFile ? { LOOPSMITH_HANDOFF_FILE: handoffFile } : {}), ...(questionFile ? { LOOPSMITH_QUESTION_FILE: questionFile } : {}) },
      timeoutMs: stage.timeoutMinutes ? stage.timeoutMinutes * 60_000 : undefined,
      onStdout: (c) => { keep(c); usageOut?.push(c); this.log(run, step.index, c, "out"); liveUsage(); },
      onStderr: (c) => { keep(c); usageErr?.push(c); this.log(run, step.index, c, "err"); liveUsage(); },
    });
    this.procs.set(run.id, proc);
    const res = await proc.done;
    this.procs.delete(run.id);
    usageOut?.flush();
    usageErr?.flush();

    let output = parser?.result ?? res.stdout;
    if (outputFile && fs.existsSync(outputFile)) {
      const fileOut = fs.readFileSync(outputFile, "utf8");
      if (fileOut.trim()) output = fileOut;
      fs.rmSync(outputFile, { force: true });
    }
    output = output.length > MAX_OUTPUT ? "…" + output.slice(-MAX_OUTPUT) : output;

    step.exitCode = res.code;
    step.output = output;
    step.costUsd = parser?.costUsd;
    if (stage.type === "agent") {
      const found = sessionPattern ? raw.match(new RegExp(sessionPattern))?.[1] : undefined;
      step.sessionId = found ?? sessionId;
      const u = usageOut?.usage ?? usageErr?.usage;
      step.usage = u;
      if (u && (usageOut?.cumulative || usageErr?.cumulative)) {
        // A running session total: subtract what earlier steps of the same session already counted.
        step.sessionUsage = u;
        const before = step.sessionId ? [...run.steps].reverse().find((x) => x.index < step.index && x.sessionId === step.sessionId && x.sessionUsage)?.sessionUsage : undefined;
        if (before) step.usage = usageSince(u, before) ?? u;
      }
    }
    run.outputs[stage.id] = output;

    if (res.killed && run.status !== "running") { step.status = "stopped"; return "fail"; }
    if (res.killed) step.note = `timed out after ${stage.timeoutMinutes} min`;
    step.status = res.code === 0 ? "done" : "failed";

    if (stage.type === "agent") {
      const s = stage as AgentStage;
      const question = questionFile && res.code === 0 && fs.existsSync(questionFile) ? fs.readFileSync(questionFile, "utf8").trim() : "";
      if (question) {
        step.question = question.slice(0, 8000);
        step.status = "waiting";
        step.note = "the agent has questions for you";
        this.log(run, step.index, `\n[loopsmith] the agent stopped to ask you:\n${step.question}\n`);
        return "ask";
      }

      if (handoffFile && res.code === 0) {
        let note = fs.existsSync(handoffFile) ? fs.readFileSync(handoffFile, "utf8").trim() : "";
        if (note) {
          this.log(run, step.index, `\n[loopsmith] handoff note saved (${note.length} chars)\n`);
        } else if (output.trim()) {
          // The agent forgot the note. The end of its final answer is the next best thing.
          note = `(The agent wrote no handoff note. This is the end of its final answer.)\n\n${output.trim().slice(-1500)}`;
          this.log(run, step.index, `\n[loopsmith] the agent did not write a handoff note; the end of its answer is used\n`);
        }
        if (note) {
          step.handoff = note.length > 8000 ? note.slice(0, 8000) + "\n…(cut)" : note;
          run.handoffs.push({ stepIndex: step.index, stageId: stage.id, stageName: step.stageName, attempt: step.attempt, harness: step.harness, note: step.handoff, at: new Date().toISOString() });
        }
      }

      if (s.extract && res.code === 0) {
        // The final answer wins. The handoff note fills gaps: pi -p prints only the last message, which can lack the score.
        step.vars = { ...extractVars(step.handoff ?? "", s.extract), ...extractVars(output, s.extract) };
        Object.assign(run.vars, step.vars);
        const missing = Object.keys(s.extract).filter((k) => step.vars![k] === undefined);
        if (missing.length) {
          this.log(run, step.index, `\n[loopsmith] could not find ${missing.join(", ")} in the output\n`);
          if (s.requireExtract !== false) {
            step.status = "failed";
            step.note = `no ${missing.join(", ")} in the output`;
            return "fail";
          }
        }
      }
    }
    return res.code === 0 ? "ok" : "fail";
  }

  private async refreshPr(run: Run, step: Step) {
    if (run.pr) return;
    try {
      const pr = await this.host.findPr(run.branch);
      if (pr) { run.pr = { number: pr.number, url: pr.url }; this.log(run, step.index, `\n[loopsmith] found PR #${pr.number}\n`); }
    } catch (e: any) {
      this.log(run, step.index, `\n[loopsmith] could not look up PR: ${e.message}\n`);
    }
  }

  nextStageId(run: Run, stage: Stage): string {
    const ctx = this.context(run, undefined, this.getConfig());
    for (const t of stage.next ?? []) {
      if (!t.when || evalCondition(t.when, ctx)) return t.goto;
    }
    const i = run.pipeline.findIndex((s) => s.id === stage.id);
    return run.pipeline[i + 1]?.id ?? "end";
  }

  private context(run: Run, step: Step | undefined, cfg: Config) {
    return {
      issue: run.issue,
      pr: run.pr ?? {},
      branch: run.branch,
      baseBranch: cfg.baseBranch,
      worktree: run.worktree,
      vars: run.vars,
      feedback: run.feedback ?? "",
      handoff: formatHandoffs(run.handoffs, cfg.handoffMaxChars ?? 12000),
      stages: Object.fromEntries(Object.entries(run.outputs).map(([k, v]) => [k, { output: v }])),
      iteration: step?.attempt ?? 1,
      run: { id: run.id, autoApprove: run.options.autoApprove },
    };
  }

  private waitingStep(id: string) {
    const run = this.must(id);
    const step = run.steps.at(-1);
    if (run.status !== "waiting_approval" || !step) throw new Error("Run is not waiting for approval");
    return { run, step };
  }

  private stage(run: Run, id: string): Stage {
    const s = run.pipeline.find((x) => x.id === id);
    if (!s) throw new Error(`Stage "${id}" is not in this run's pipeline`);
    return s;
  }

  private must(id: string): Run {
    const r = this.runs.get(id);
    if (!r) throw new Error(`No run ${id}`);
    return r;
  }
}

/** Issue-number order, but an issue always comes after the selected issues that block it. */
export function orderByBlockers(issues: Issue[]): Issue[] {
  const byNum = new Map(issues.map((i) => [i.number, i]));
  const seen = new Set<number>();
  const out: Issue[] = [];
  const visit = (i: Issue) => {
    if (seen.has(i.number)) return;
    seen.add(i.number);
    for (const b of [...(i.blockedBy ?? [])].sort((a, c) => a - c)) { const dep = byNum.get(b); if (dep) visit(dep); }
    out.push(i);
  };
  [...issues].sort((a, b) => a.number - b.number).forEach(visit);
  return out;
}

/** All notes, newest last. If too long, drop the oldest notes first. */
export function formatHandoffs(notes: HandoffNote[], maxChars: number): string {
  if (!notes.length) return "";
  const parts = notes.map((n) => `### From "${n.stageName}"${n.attempt > 1 ? ` (round ${n.attempt})` : ""}${n.harness ? ` · ${n.harness}` : ""}\n\n${n.note}`);
  let dropped = 0;
  while (parts.length > 1 && parts.join("\n\n").length > maxChars) { parts.shift(); dropped++; }
  const head = "## Handoff notes from earlier agents (oldest first)" + (dropped ? `\n(${dropped} older note(s) left out to save space)` : "");
  return `${head}\n\n${parts.join("\n\n")}`;
}
