/**
 * Turns `claude -p --output-format stream-json --verbose` events into
 * readable log lines, and remembers the final result text.
 */
export class ClaudeStreamParser {
  private buf = "";
  result: string | undefined;
  costUsd: number | undefined;

  push(chunk: string): string {
    this.buf += chunk;
    const lines = this.buf.split("\n");
    this.buf = lines.pop() ?? "";
    return lines.map((l) => this.line(l)).join("");
  }

  flush(): string {
    const rest = this.buf;
    this.buf = "";
    return rest ? this.line(rest) : "";
  }

  private line(raw: string): string {
    if (!raw.trim()) return "";
    let ev: any;
    try { ev = JSON.parse(raw); } catch { return raw + "\n"; }
    if (ev.type === "system" && ev.subtype === "init") return `● session ${ev.session_id ?? ""} (${ev.model ?? "model?"})\n`;
    if (ev.type === "assistant") {
      return (ev.message?.content ?? [])
        .map((c: any) => {
          if (c.type === "text") return c.text + "\n";
          if (c.type === "tool_use") return `→ ${c.name} ${summarize(c.input)}\n`;
          return "";
        })
        .join("");
    }
    if (ev.type === "user") {
      return (ev.message?.content ?? [])
        .filter((c: any) => c.type === "tool_result" && c.is_error)
        .map((c: any) => `  ✗ tool error: ${short(typeof c.content === "string" ? c.content : JSON.stringify(c.content))}\n`)
        .join("");
    }
    if (ev.type === "result") {
      this.result = ev.result;
      if (ev.total_cost_usd != null) this.costUsd = Number(ev.total_cost_usd);
      const cost = ev.total_cost_usd != null ? ` · $${Number(ev.total_cost_usd).toFixed(2)}` : "";
      return `\n● finished: ${ev.subtype ?? ""} · ${ev.num_turns ?? "?"} turns${cost}\n`;
    }
    return "";
  }
}

function summarize(input: any): string {
  if (!input) return "";
  const key = input.command ?? input.file_path ?? input.pattern ?? input.path ?? input.url ?? input.description;
  return short(key ? String(key) : JSON.stringify(input));
}

function short(s: string, n = 160) {
  s = s.replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n) + "…" : s;
}
