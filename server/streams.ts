/**
 * Reads `claude -p --output-format stream-json --verbose` events and remembers the
 * final result text and cost. Display formatting happens in the UI (web/src/format.ts).
 */
export class ClaudeStreamParser {
  private buf = "";
  result: string | undefined;
  costUsd: number | undefined;

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
    let ev: any;
    try { ev = JSON.parse(raw); } catch { return; }
    if (ev?.type !== "result") return;
    this.result = ev.result;
    if (ev.total_cost_usd != null) this.costUsd = Number(ev.total_cost_usd);
  }
}
