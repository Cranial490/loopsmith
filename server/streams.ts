/**
 * Token usage of one step, as the CLI reported it. Missing fields were not reported.
 * - input: input tokens NOT served from cache (Codex reports cached input inside
 *   input_tokens; we subtract it, so the fields never overlap)
 * - cacheRead / cacheWrite: input tokens read from / written to the prompt cache
 * - output: output tokens (includes reasoning/thinking tokens)
 * - total: input + cacheRead + cacheWrite + output. When the CLI only reports one
 *   number (Codex text output), that number.
 * - partial: a live estimate; the CLI's final usage was not seen (yet).
 * These are token counts, not a charge.
 */
export interface TokenUsage {
  input?: number;
  cacheRead?: number;
  cacheWrite?: number;
  output?: number;
  total: number;
  partial?: boolean;
}

const PARTS = ["input", "cacheRead", "cacheWrite", "output"] as const;

function usage(parts: Partial<Record<(typeof PARTS)[number], unknown>>): TokenUsage | undefined {
  const u: TokenUsage = { total: 0 };
  for (const k of PARTS) {
    const n = Number(parts[k]);
    if (parts[k] != null && Number.isFinite(n)) { u[k] = n; u.total += n; }
  }
  return PARTS.some((k) => u[k] !== undefined) ? u : undefined;
}

const claudeUsage = (x: any) => x && typeof x === "object"
  ? usage({ input: x.input_tokens, cacheRead: x.cache_read_input_tokens, cacheWrite: x.cache_creation_input_tokens, output: x.output_tokens })
  : undefined;

const codexUsage = (x: any) => x && typeof x === "object"
  ? usage({ input: x.input_tokens != null ? Number(x.input_tokens) - Number(x.cached_input_tokens ?? 0) : undefined, cacheRead: x.cached_input_tokens, cacheWrite: x.cache_write_input_tokens, output: x.output_tokens })
  : undefined;

/** Usage between an earlier cumulative report and this one; undefined when a counter went down (the session count restarted). */
export function usageSince(now: TokenUsage, before: TokenUsage): TokenUsage | undefined {
  if ([...PARTS, "total" as const].some((k) => (now[k] ?? 0) < (before[k] ?? 0))) return undefined;
  const d: TokenUsage = { ...now, total: now.total - before.total };
  for (const k of PARTS) if (now[k] !== undefined) d[k] = now[k]! - (before[k] ?? 0);
  return d;
}

/**
 * Reads one output stream of an agent CLI and remembers the final result text, cost and token usage.
 * - "claude-stream-json": `result.usage` is the usage of this one `claude -p` process (also when it
 *   resumes a session). Before it arrives, `assistant` events give a live estimate: each message's usage,
 *   counted once per message id (one message repeats per content block).
 * - "codex-json": `turn.completed.usage` is the running total of the whole Codex session (`cumulative`).
 * - "text": only Codex's `tokens used` footer (after the Codex banner): one running total, no breakdown.
 * Display formatting happens in the UI (web/src/format.ts).
 */
export class StreamParser {
  private buf = "";
  private live = new Map<string, TokenUsage>();
  private codexBanner = false;
  private tokensNext = false;
  result: string | undefined;
  costUsd: number | undefined;
  usage: TokenUsage | undefined;
  /** The usage is a running total for the CLI session, which earlier steps may share. */
  cumulative = false;

  constructor(private format: string = "claude-stream-json") {}

  push(chunk: string) {
    this.buf += chunk;
    const lines = this.buf.split("\n");
    this.buf = lines.pop() ?? "";
    lines.forEach((l) => this.line(l));
  }

  flush() {
    const rest = this.buf;
    this.buf = "";
    if (rest) this.line(rest);
  }

  private line(raw: string) {
    if (this.format === "text") return this.textLine(raw.replace(/\x1b\[[0-9;]*m/g, "").trim());
    let ev: any;
    try { ev = JSON.parse(raw); } catch { return; }
    if (!ev || typeof ev !== "object") return;
    if (this.format === "codex-json") {
      const u = ev.type === "turn.completed" ? codexUsage(ev.usage) : undefined;
      if (u) { this.usage = u; this.cumulative = true; }
      return;
    }
    if (ev.type === "assistant" && ev.message?.id != null) {
      const u = claudeUsage(ev.message.usage);
      if (u && (!this.usage || this.usage.partial)) {
        this.live.set(String(ev.message.id), u);
        this.usage = { ...[...this.live.values()].reduce(add), partial: true };
      }
    }
    if (ev.type !== "result") return;
    this.result = ev.result;
    if (ev.total_cost_usd != null) this.costUsd = Number(ev.total_cost_usd);
    const u = claudeUsage(ev.usage);
    if (u) this.usage = u;
  }

  private textLine(l: string) {
    if (/^OpenAI Codex v/.test(l)) this.codexBanner = true;
    if (!this.codexBanner) return;
    const m = l.match(/^(?:\[[^\]]*\]\s*)?tokens used:?\s*([\d,]*)$/);
    const n = m ? m[1] : this.tokensNext && /^[\d,]+$/.test(l) ? l : undefined;
    this.tokensNext = !!m && !m[1];
    if (n) { this.usage = { total: Number(n.replace(/,/g, "")) }; this.cumulative = true; }
  }
}

/** Adds usage; a part stays missing only when it is missing in both. */
export function add(a: TokenUsage, b: TokenUsage): TokenUsage {
  const s: TokenUsage = { total: a.total + b.total };
  for (const k of PARTS) if (a[k] !== undefined || b[k] !== undefined) s[k] = (a[k] ?? 0) + (b[k] ?? 0);
  return s;
}

/**
 * Token usage of agent steps added up (shell and approval steps use no tokens).
 * `incomplete`: some agent step has no reported usage (failed, stopped, still running, older run) or only a live estimate.
 */
export function sumUsage(steps: { type: string; status: string; usage?: TokenUsage }[]): (TokenUsage & { steps: number; incomplete: boolean }) | undefined {
  const agent = steps.filter((s) => s.type === "agent" && s.status !== "skipped");
  if (!agent.length) return undefined;
  const got = agent.filter((s) => s.usage).map((s) => s.usage!);
  const sum = got.reduce(add, { total: 0 });
  return { ...sum, steps: got.length, incomplete: got.length < agent.length || got.some((u) => u.partial) };
}

