import type { Stage } from "./config.js";


/** Replace {{a.b.c}} with values from ctx. Missing values become "". */
export function render(tpl: string, ctx: Record<string, any>): string {
  return tpl.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, key: string) => {
    const v = lookup(ctx, key);
    return v === undefined || v === null ? "" : String(v);
  });
}

/** Like render, but for bash commands: a value with unsafe characters is single-quoted. */
export function renderShell(tpl: string, ctx: Record<string, any>): string {
  return tpl.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, key: string) => {
    const v = lookup(ctx, key);
    const s = v === undefined || v === null ? "" : String(v);
    return /^[\w@%+=:,.\/-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
  });
}

export function lookup(ctx: Record<string, any>, key: string): any {
  return key.split(".").reduce<any>((o, k) => (o == null ? undefined : o[k]), ctx);
}

const OPS = ["==", "!=", ">=", "<=", ">", "<"] as const;

/**
 * Small, safe condition language: `<name> <op> <value>`.
 * Names are looked up in vars first, then in the full context ("pr.number").
 * Examples: "score >= 8", "status == approved", "pr.number != ".
 */
export function evalCondition(expr: string, ctx: Record<string, any>): boolean {
  const m = expr.trim().match(/^([\w.-]+)\s*(==|!=|>=|<=|>|<)\s*(.*)$/);
  if (!m) throw new Error(`Cannot read condition "${expr}". Use: name >= 8`);
  const [, name, op, rawRight] = m as unknown as [string, string, (typeof OPS)[number], string];
  let left = lookup(ctx.vars ?? {}, name);
  if (left === undefined) left = lookup(ctx, name);
  const right = rawRight.trim().replace(/^["']|["']$/g, "");
  const ln = Number(left), rn = Number(right);
  const numeric = left !== undefined && left !== "" && right !== "" && !isNaN(ln) && !isNaN(rn);
  if (op === "==") return numeric ? ln === rn : String(left ?? "") === right;
  if (op === "!=") return numeric ? ln !== rn : String(left ?? "") !== right;
  if (!numeric) return false;
  if (op === ">=") return ln >= rn;
  if (op === "<=") return ln <= rn;
  if (op === ">") return ln > rn;
  return ln < rn;
}

/** Run every extract regex on text. The capture of the LAST match wins. */
export function extractVars(text: string, extract: Record<string, string> = {}) {
  const out: Record<string, string | number> = {};
  for (const [name, re] of Object.entries(extract)) {
    const matches = [...text.matchAll(new RegExp(re, "gim"))];
    const last = matches.at(-1);
    if (last) {
      const v = last[1] ?? last[0];
      out[name] = v !== "" && !isNaN(Number(v)) ? Number(v) : v;
    }
  }
  return out;
}

/** Rename a stage and every reference to it (goto, continueFrom, sendBackTo, {{stages.<id>.output}}). */
export function renameStage(pipeline: Stage[], oldId: string, newId: string): Stage[] {
  const id = (x: string) => (x === oldId ? newId : x);
  const ref = new RegExp(`(\\{\\{\\s*stages\\.)${oldId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\.output\\s*\\}\\})`, "g");
  const tpl = (t: string) => t.replace(ref, (_, a, b) => a + newId + b);
  return pipeline.map((s) => {
    const r: any = { ...s, id: id(s.id) };
    if (s.next) r.next = s.next.map((t) => ({ ...t, goto: id(t.goto) }));
    if (s.type === "agent") {
      r.prompt = tpl(s.prompt);
      if (s.continueFrom) r.continueFrom = s.continueFrom.map(id);
    }
    if (s.type === "shell") r.command = tpl(s.command);
    if (s.type === "approval") {
      if (s.message) r.message = tpl(s.message);
      if (s.sendBackTo) r.sendBackTo = id(s.sendBackTo);
    }
    return r;
  });
}
