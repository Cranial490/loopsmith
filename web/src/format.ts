/**
 * Turns a raw step log (stdout/stderr/loopsmith chunks) into display blocks.
 * Understands Claude stream-json, Codex `exec` text and `--json` events; anything
 * else falls back to plain output. Display only: the pipeline never reads this.
 */
export type Chunk = { s: "out" | "err" | "sys"; t: string };

export type Block =
  | { kind: "message"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool"; id?: string; name: string; summary: string; detail: string; input?: string; result?: string; error?: boolean; running?: boolean; stopped?: boolean }
  | { kind: "output"; text: string }
  | { kind: "error"; title: string; detail?: string }
  | { kind: "warn"; text: string }
  | { kind: "system"; text: string }
  | { kind: "noise"; title: string; lines: string[] }
  | { kind: "done"; title: string; text?: string };

type Section = null | "header" | "user" | "thinking" | "exec" | "codex" | "tokens";
const CODEX_HEADERS = new Map<string, Section>([["user", "user"], ["thinking", "thinking"], ["exec", "exec"], ["codex", "codex"], ["tokens used", "tokens"]]);
const TS = /^\[\d{4}-\d\d-\d\dT[^\]]*\]\s*/;
const DEBUG = /^(\S*\d{4}-\d\d-\d\dT\S+\s+(TRACE|DEBUG|INFO)\b|stream error:.*retrying|Reconnecting\.\.\.|\[?(DEBUG|TRACE)\]?\s)/;
const LEVEL = (up: string, low: string) => new RegExp(`^(?:\\S*\\d{4}-\\d\\d-\\d\\dT\\S+\\s+(?:${up})\\b|(?:${up})\\b|(?:${low})(?:\\[\\w+\\])?:)[:\\s]*`);
const ERROR = LEVEL("ERROR|FATAL", "Error|error|fatal");
const CLI_ERROR = /^(?:\S*\d{4}-\d\d-\d\dT\S+\s+)?(?:ERROR|FATAL)\b/;
const WARN = LEVEL("WARN|WARNING", "Warning|warning");

export class LogFormatter {
  private list: Block[] = [];
  private buf = { out: "", err: "" };
  private section: Section = null;
  private codex = false;
  /** A finished command whose output may continue: an "exec" line in its output is only a new command if a command line follows. */
  private maybeExec: Extract<Block, { kind: "tool" }> | undefined;
  /** Codex --json items by id, so start/update/completion share one block. */
  private items = new Map<string, Block>();

  push(c: Chunk) {
    if (c.s === "sys") return this.sys(c.t);
    const lines = (this.buf[c.s] + c.t).split("\n");
    this.buf[c.s] = lines.pop() ?? "";
    for (const l of lines) this.line(l.replace(/\r$/, ""));
  }

  /** The step ended: lines without a final newline are complete now. */
  end() {
    for (const s of ["out", "err"] as const) {
      const rest = this.buf[s];
      this.buf[s] = "";
      if (rest) this.line(rest.replace(/\r$/, ""));
    }
    // Commands that never reported a status: the step is over, so they stopped. Not a success.
    for (const b of this.list) if (b.kind === "tool" && b.running) { delete b.running; b.stopped = true; }
  }

  /** The blocks so far, plus unfinished lines so live output shows at once. */
  blocks(): Block[] {
    const out = [...this.list];
    for (const p of [this.buf.out, this.buf.err]) {
      if (!p || (!this.section && p.trimStart().startsWith("{"))) continue; // a JSON event still arriving
      const last = out.at(-1);
      if ((this.section === "codex" || this.section === "thinking") && (last?.kind === "message" || last?.kind === "thinking")) out[out.length - 1] = { ...last, text: last.text + p };
      else if (this.section === "exec" && last?.kind === "tool" && last.detail) out[out.length - 1] = { ...last, result: (last.result ?? "") + p };
      else if (this.section) continue;
      else if (last?.kind === "output") out[out.length - 1] = { kind: "output", text: last.text + p };
      else out.push({ kind: "output", text: p });
    }
    return out;
  }

  private add<B extends Block>(b: B): B { this.list.push(b); return b; }
  private last() { return this.list.at(-1); }

  private sys(t: string) {
    const text = t.trim();
    if (!text) return;
    this.section = null;
    if (text.startsWith("$ ")) this.add({ kind: "tool", name: "Command", summary: short(text.slice(2)), detail: text.slice(2) });
    else this.add({ kind: "system", text });
  }

  private noise(title: string, line: string) {
    const l = this.last();
    if (l?.kind === "noise" && l.title === title) l.lines.push(line);
    else this.add({ kind: "noise", title, lines: [line] });
  }

  private line(raw: string) {
    // Structured CLI events only outside Codex text sections: JSON a command prints is just output.
    if (!this.section && raw.trimStart().startsWith("{")) {
      let handled = false;
      try {
        const ev = JSON.parse(raw);
        handled = !!ev && typeof ev.type === "string" && wellFormed(ev) && this.event(ev);
      } catch {}
      if (handled) return;
    }
    const bare = raw.replace(TS, "");
    const header = CODEX_HEADERS.get(bare.trim());
    if (/^OpenAI Codex v/.test(bare)) { this.codex = true; this.section = "header"; return this.add({ kind: "noise", title: "Codex startup", lines: [raw] }); }
    if (this.section === "header") {
      if (bare.trim() === "--------" && this.last()?.kind === "noise" && (this.last() as any).lines.length > 1) this.section = null;
      return this.noise("Codex startup", raw);
    }
    const prev = this.maybeExec;
    this.maybeExec = undefined;
    if (header && (this.codex || TS.test(raw)) && this.isHeader(header)) {
      const last = this.last();
      this.codexHeader(header);
      if (header === "exec" && last?.kind === "tool" && !last.running) this.maybeExec = last;
      return;
    }

    const sec = this.section;
    if (sec === "exec") {
      const tool = this.last();
      // Codex reports its own failures as ERROR/FATAL lines (maybe timestamped); one during a command means it failed.
      // Lowercase "Error:" stays command output: programs print those (stack traces).
      if (tool?.kind === "tool" && CLI_ERROR.test(bare)) {
        if (tool.running) { tool.error = true; delete tool.running; }
        this.section = null;
        return this.add({ kind: "error", title: readableError(bare), detail: raw });
      }
      if (tool?.kind === "tool") {
        if (!tool.detail && prev && !/ in \S+$/.test(bare)) {
          // Not a new command after all: "exec" was part of the previous output.
          this.list.pop();
          prev.result = (prev.result ?? "") + "exec\n" + raw + "\n";
          return;
        }
        if (!tool.detail) { tool.detail = bare.replace(/ in \S+$/, ""); tool.summary = short(unwrapShell(tool.detail)); return; }
        const status = /^\s*(succeeded|exited (-?\d+)|failed)\b.*:$/.exec(bare);
        if (status && tool.running) { tool.error = status[1] !== "succeeded"; tool.result ??= ""; delete tool.running; return; }
        tool.result = (tool.result ?? "") + raw + "\n";
        return;
      }
    }
    if (sec === "tokens") {
      const done = this.last();
      if (done?.kind === "done" && bare.trim()) { done.title = `Finished · ${bare.trim()} tokens used`; this.section = null; }
      return;
    }
    // Codex reports failures as ERROR/FATAL lines (maybe timestamped) at any point, also right after
    // the prompt or while thinking. Inside a code fence of a message they are only example text.
    if (sec === "user" && !CLI_ERROR.test(bare)) return this.noise("Prompt", raw);
    if (sec === "thinking" || sec === "codex") {
      const b = this.last();
      if (b && (b.kind === "thinking" || b.kind === "message") && (!CLI_ERROR.test(bare) || inFence(b.text))) { b.text += raw + "\n"; return; }
    }

    if (!raw.trim()) {
      const l = this.last();
      if (l?.kind === "output") l.text += "\n";
      return;
    }
    if (bare.startsWith("[loopsmith] ")) return this.add({ kind: "system", text: bare });
    if (DEBUG.test(bare)) return this.noise("Startup / debug / retry lines", raw);
    if (ERROR.test(bare)) { this.section = null; return this.add({ kind: "error", title: readableError(bare), detail: raw }); }
    if (WARN.test(bare)) return this.add({ kind: "warn", text: bare.replace(WARN, "").trim() || bare });
    this.output(raw);
  }

  private output(line: string) {
    const l = this.last();
    if (l?.kind === "output") l.text += line + "\n";
    else this.add({ kind: "output", text: line + "\n" });
  }

  /** Is a Codex section word a real section start here, or just text that looks like one? */
  private isHeader(h: Section): boolean {
    const last = this.last();
    if (h === "user") return last?.kind === "noise" && last.title === "Codex startup";
    if (this.section === "exec" && last?.kind === "tool" && last.running) return false;
    if ((this.section === "codex" || this.section === "thinking") && (last?.kind === "message" || last?.kind === "thinking")) {
      return !inFence(last.text);
    }
    return true;
  }

  private codexHeader(h: Section) {
    this.section = h;
    if (h === "thinking") this.add({ kind: "thinking", text: "" });
    else if (h === "codex") this.add({ kind: "message", text: "" });
    else if (h === "exec") this.add({ kind: "tool", name: "Shell", summary: "", detail: "", running: true });
    else if (h === "tokens") this.add({ kind: "done", title: "Finished" });
    else if (h === "user") this.add({ kind: "noise", title: "Prompt", lines: [] });
  }

  /** Structured CLI events. Returns false for unknown events (shown as plain text). */
  private event(ev: any): boolean {
    switch (ev.type) {
      // Claude Code stream-json
      case "system":
        if (ev.subtype === "init") this.add({ kind: "system", text: `Session ${ev.session_id ?? "?"} · ${ev.model ?? "model?"}` });
        else this.noise("System events", JSON.stringify(ev));
        return true;
      case "assistant":
        for (const c of list(ev.message?.content)) {
          if (c.type === "text" && /^API Error/.test(c.text)) this.add({ kind: "error", title: readableError(c.text), detail: c.text });
          else if (c.type === "text") this.add({ kind: "message", text: c.text });
          else if (c.type === "thinking" && c.thinking) this.add({ kind: "thinking", text: c.thinking });
          else if (c.type === "tool_use") this.add({ kind: "tool", id: c.id, name: c.name, summary: summarize(c.input), ...toolDetail(c.input) });
          else if (c.type !== "thinking" && c.type !== "redacted_thinking") this.output(JSON.stringify(c)); // unknown content: keep it readable
        }
        return true;
      case "user":
        for (const c of list(ev.message?.content)) {
          if (c.type !== "tool_result") { this.output(JSON.stringify(c)); continue; }
          const tool = this.list.find((b): b is Extract<Block, { kind: "tool" }> => b.kind === "tool" && b.id === c.tool_use_id);
          if (tool) { tool.result = text(c.content); tool.error = !!c.is_error; }
          else this.add({ kind: "tool", name: "Tool result", summary: short(text(c.content)), detail: JSON.stringify(c, null, 2), result: text(c.content), error: !!c.is_error });
        }
        return true;
      case "result": {
        if (ev.is_error || String(ev.subtype ?? "").startsWith("error")) {
          const detail = String(ev.result ?? ev.subtype ?? "error");
          this.add({ kind: "error", title: readableError(detail), detail });
          return true;
        }
        const cost = ev.total_cost_usd != null ? ` · $${Number(ev.total_cost_usd).toFixed(2)}` : "";
        this.add({ kind: "done", title: `Finished · ${ev.num_turns ?? "?"} turns${cost}`, text: ev.result });
        return true;
      }
      case "stream_event":
      case "rate_limit_event":
        return true;
      // Codex exec --json
      case "thread.started": this.add({ kind: "system", text: `Session ${ev.thread_id}` }); return true;
      case "turn.started": return true;
      case "turn.completed": this.add({ kind: "done", title: `Finished${ev.usage?.output_tokens != null ? ` · ${ev.usage.input_tokens ?? 0} in / ${ev.usage.output_tokens} out tokens` : ""}` }); return true;
      case "turn.failed": this.add({ kind: "error", title: readableError(ev.error?.message ?? "turn failed"), detail: JSON.stringify(ev) }); return true;
      case "error": this.add({ kind: "error", title: readableError(ev.message ?? JSON.stringify(ev)), detail: JSON.stringify(ev) }); return true;
      case "item.started": case "item.updated": case "item.completed": {
        const it = ev.item && typeof ev.item === "object" ? ev.item : {};
        const b = itemBlock(it, ev.type === "item.completed");
        const old = it.id != null ? this.items.get(it.id) : undefined;
        if (old) { for (const k of Object.keys(old)) delete (old as any)[k]; Object.assign(old, b); }
        else if (b && (ev.type === "item.completed" || b.kind === "tool")) { this.add(b); if (it.id != null) this.items.set(it.id, b); }
        return true;
      }
    }
    return false;
  }
}

function itemBlock(it: any, done: boolean): Block {
  if (it.type === "agent_message") return { kind: "message", text: it.text ?? "" };
  if (it.type === "reasoning") return { kind: "thinking", text: it.text ?? "" };
  if (it.type === "error") return { kind: "error", title: readableError(it.message ?? ""), detail: JSON.stringify(it) };
  if (it.type === "command_execution") {
    const cmd = String(it.command ?? "");
    const b: Extract<Block, { kind: "tool" }> = { kind: "tool", name: "Shell", summary: short(unwrapShell(cmd)), detail: cmd };
    b.result = String(it.aggregated_output ?? "");
    if (done || it.exit_code != null) b.error = it.status === "failed" || it.status === "declined" || (it.exit_code != null && it.exit_code !== 0);
    else b.running = true; // output so far; not finished yet
    return b;
  }
  return { kind: "tool", name: it.type ?? "item", summary: summarize(it), detail: JSON.stringify(it, null, 2) };
}

export function formatLog(chunks: Chunk[]): Block[] {
  const f = new LogFormatter();
  chunks.forEach((c) => f.push(c));
  return f.blocks();
}

/** The human message inside an error line, e.g. the `message` of an embedded JSON error. */
export function readableError(s: string): string {
  const i = s.indexOf("{"), k = s.lastIndexOf("}");
  if (i >= 0 && k > i) {
    try {
      const o = JSON.parse(s.slice(i, k + 1));
      const m = o?.error?.message ?? o?.message ?? o?.detail ?? o?.error;
      if (typeof m === "string" && m) return m;
    } catch {}
  }
  return s.replace(ERROR, "").trim() || s;
}

/** The command itself when there is one, and the full input with every argument. */
function toolDetail(input: any): { detail: string; input?: string } {
  const all = JSON.stringify(input, null, 2) ?? "";
  if (typeof input?.command !== "string") return { detail: all };
  return Object.keys(input).length > 1 ? { detail: input.command, input: all } : { detail: input.command };
}

/** Is the end of this text inside an open ``` / ~~~ code fence? */
const inFence = (t: string) => (t.match(/^\s*(```|~~~)/gm)?.length ?? 0) % 2 === 1;

const str = (x: unknown) => typeof x === "string";
const optStr = (x: unknown) => x == null || typeof x === "string";

/** Fields that become display text must be strings; other shapes are shown as plain text instead. */
function wellFormed(ev: any): boolean {
  if (ev.type === "result") return optStr(ev.result) && optStr(ev.subtype);
  if (ev.type === "assistant" || ev.type === "user") {
    const content = ev.message?.content;
    if (!Array.isArray(content) || !content.every((c) => c && typeof c === "object")) return false;
    return content.every((c: any) =>
      c.type === "text" ? str(c.text) : c.type === "thinking" ? optStr(c.thinking) : c.type === "tool_use" ? str(c.name) && optStr(c.id) : true);
  }
  if (ev.type?.startsWith?.("item.")) {
    const it = ev.item ?? {};
    return typeof it === "object" && optStr(it.text) && optStr(it.command) && optStr(it.message) && optStr(it.type) && optStr(it.id);
  }
  if (ev.type === "error" || ev.type === "turn.failed") return optStr(ev.message) && optStr(ev.error?.message);
  return true;
}

const list = (x: unknown): any[] => (Array.isArray(x) ? x.filter((c) => c && typeof c === "object") : []);

function text(c: unknown): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((x) => (typeof x?.text === "string" ? x.text : JSON.stringify(x))).join("\n");
  return JSON.stringify(c);
}

function summarize(input: any): string {
  if (!input) return "";
  const key = input.command ?? input.file_path ?? input.pattern ?? input.path ?? input.url ?? input.description ?? input.changes?.map?.((c: any) => c.path).join(", ");
  return short(key ? String(key) : JSON.stringify(input));
}

function unwrapShell(cmd: string) {
  const m = /^(?:\/\S*\/)?(?:ba|z)?sh -lc (['"])([\s\S]*)\1$/.exec(cmd.trim());
  return m ? m[2] : cmd;
}

function short(s: string, n = 120) {
  s = s.replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n) + "…" : s;
}
