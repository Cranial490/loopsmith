import type { Run, Step, SpecGraph, NodeStatus } from "../../server/engine";
import type { TokenUsage } from "../../server/streams";
export { sumUsage } from "../../server/streams";
import type { Config, Stage, HarnessConfig } from "../../server/config";
import type { Issue } from "../../server/github";
import type { Chunk } from "./format";
export type { Run, Step, SpecGraph, NodeStatus, Config, Stage, HarnessConfig, Issue, TokenUsage };

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText);
  return res.headers.get("content-type")?.includes("json") ? res.json() : (res.text() as any);
}

export const api = {
  state: () => call<{ repo: string; demo: boolean; config: Config; runs: Run[] }>("GET", "/api/state"),
  issues: () => call<Issue[]>("GET", "/api/issues"),
  specs: () => call<Issue[]>("GET", "/api/specs"),
  spec: (n: number, refresh = false) => call<SpecGraph>("GET", `/api/specs/${n}${refresh ? "?refresh=1" : ""}`),
  start: (issues: Issue[], autoApprove: boolean) => call<Run[]>("POST", "/api/runs", { issues, autoApprove }),
  approve: (id: string) => call("POST", `/api/runs/${id}/approve`),
  reject: (id: string) => call("POST", `/api/runs/${id}/reject`),
  stop: (id: string) => call("POST", `/api/runs/${id}/stop`),
  answer: (id: string, text: string) => call("POST", `/api/runs/${id}/answer`, { text }),
  sendBack: (id: string, notes: string) => call("POST", `/api/runs/${id}/send-back`, { notes }),
  resume: (id: string, resetLimits = false, fromStage?: string) => call("POST", `/api/runs/${id}/resume`, { resetLimits, fromStage }),
  remove: (id: string) => call("DELETE", `/api/runs/${id}`),
  log: (id: string, index: number) => call<Chunk[]>("GET", `/api/runs/${id}/steps/${index}/log`),
  saveConfig: (cfg: Config) => call<Config>("PUT", "/api/config", cfg),
  defaultConfig: () => call<Config>("GET", "/api/config/default"),
  models: () => call<Record<string, string[]>>("GET", "/api/models"),
};

/** A live log chunk. `n` is its position in the saved log, so gaps and repeats can be spotted. */
export type LogEvent = Chunk & { runId: string; index: number; n: number };
const logListeners = new Set<(e: LogEvent) => void>();
export const onLog = (fn: (e: LogEvent) => void) => { logListeners.add(fn); return () => { logListeners.delete(fn); }; };
/** Called when the event stream connects again; live events sent meanwhile were missed. */
const reconnectListeners = new Set<() => void>();
export const onReconnect = (fn: () => void) => { reconnectListeners.add(fn); return () => { reconnectListeners.delete(fn); }; };

export function connectEvents(handlers: { run: (r: Run) => void; removed: (id: string) => void; config: (c: Config) => void; status: (ok: boolean) => void }) {
  const es = new EventSource("/api/events");
  es.addEventListener("run", (e) => handlers.run(JSON.parse((e as MessageEvent).data)));
  es.addEventListener("removed", (e) => handlers.removed(JSON.parse((e as MessageEvent).data).id));
  es.addEventListener("config", (e) => handlers.config(JSON.parse((e as MessageEvent).data)));
  es.addEventListener("log", (e) => { const d = JSON.parse((e as MessageEvent).data); logListeners.forEach((f) => f(d)); });
  let opened = false;
  es.onopen = () => { handlers.status(true); if (opened) reconnectListeners.forEach((f) => f()); opened = true; };
  es.onerror = () => handlers.status(false);
  return () => es.close();
}

export const STATUS_LABEL: Record<string, string> = {
  queued: "Queued", running: "Running", waiting_approval: "Needs approval", waiting_input: "Has a question", done: "Done", failed: "Failed",
  stopped: "Stopped", needs_attention: "Needs attention", interrupted: "Interrupted",
};

export const NODE_LABEL: Record<NodeStatus, string> = {
  not_started: "Not started", queued: "Queued", running: "Running", waiting: "Waiting", done: "Done", failed: "Failed", needs_attention: "Needs attention", closed: "Closed",
};

export function ago(iso?: string) {
  if (!iso) return "";
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function duration(a?: string, b?: string) {
  if (!a) return "";
  const s = Math.round(((b ? new Date(b) : new Date()).getTime() - new Date(a).getTime()) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

export const NEEDS_YOU = ["waiting_approval", "waiting_input", "needs_attention", "failed", "interrupted"];

/** Blocker issues (native links or "Blocked by" text) that a queued run still waits for. */
export function waitingFor(run: Run, runs: Run[]): number[] {
  return (run.blockedBy ?? []).filter((n) => {
    const latest = runs.filter((r) => r.issue.number === n).sort((a, b) => b.seq - a.seq)[0];
    return latest && latest.status !== "done";
  });
}

export function totalCost(run: Run): number {
  return run.steps.reduce((sum, s) => sum + (s.costUsd ?? 0), 0);
}

export const tokens = (n?: number) => (n === undefined ? "?" : n < 1000 ? String(n) : n < 1e6 ? `${(n / 1e3).toFixed(n < 1e4 ? 1 : 0)}k` : `${(n / 1e6).toFixed(2)}M`);
