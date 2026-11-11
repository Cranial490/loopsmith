import { useEffect, useState } from "react";
import { api, type Issue, type Run } from "./api";

export function IssuesPanel({ runs, onStarted }: { runs: Run[]; onStarted: (r: Run[]) => void }) {
  const [issues, setIssues] = useState<Issue[] | null>(null);
  const [err, setErr] = useState("");
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [autoApprove, setAutoApprove] = useState(false);
  const [filter, setFilter] = useState("");

  const load = () => { setErr(""); api.issues().then(setIssues).catch((e) => setErr(e.message)); };
  useEffect(load, []);

  const active = new Map(runs.filter((r) => !["done", "stopped"].includes(r.status)).map((r) => [r.issue.number, r]));
  const open = new Set((issues ?? []).map((i) => i.number));
  // Blockers that are still open, not selected, and not in the loop: the issue would start without them.
  const openBlockers = (i: Issue) => (i.blockedBy ?? []).filter((n) => open.has(n));
  const missing = (issues ?? []).filter((i) => picked.has(i.number)).flatMap((i) => openBlockers(i).filter((n) => !picked.has(n) && !active.has(n)).map((n) => `#${i.number} is blocked by #${n}`));
  const shown = (issues ?? []).filter((i) => `#${i.number} ${i.title} ${(i.labels ?? []).join(" ")}`.toLowerCase().includes(filter.toLowerCase()));

  const toggle = (n: number) => setPicked((s) => { const x = new Set(s); x.has(n) ? x.delete(n) : x.add(n); return x; });
  const start = async () => {
    // The server sorts them: issue-number order, blockers first.
    const chosen = (issues ?? []).filter((i) => picked.has(i.number));
    const r = await api.start(chosen, autoApprove);
    setPicked(new Set());
    onStarted(r);
  };

  return (
    <aside className="issues">
      <div className="issues-head">
        <h3>Open issues</h3>
        <button className="ghost small" onClick={load} title="Reload">↻</button>
      </div>
      <input className="search" placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} />
      <div className="issue-list">
        {err && <div className="error">{err}</div>}
        {!issues && !err && <div className="muted pad">Loading issues…</div>}
        {shown.map((i) => {
          const run = active.get(i.number);
          return (
            <label key={i.number} className={`issue ${run ? "busy" : ""} ${picked.has(i.number) ? "picked" : ""}`}>
              <input type="checkbox" disabled={!!run} checked={picked.has(i.number)} onChange={() => toggle(i.number)} />
              <span className="num">#{i.number}</span>
              <span className="title">{i.title}
                <span className="labels">{(i.labels ?? []).map((l) => <span key={l} className="label">{l}</span>)}{openBlockers(i).map((n) => <span key={n} className="label blocked" title={`Blocked by #${n}`}>after #{n}</span>)}{run && <span className="label live">in loop</span>}</span>
              </span>
            </label>
          );
        })}
      </div>
      <div className="issues-foot">
        <label className="toggle" title="Off: the run stops at approval stages and waits for you. On: approval stages pass on their own.">
          <input type="checkbox" checked={autoApprove} onChange={(e) => setAutoApprove(e.target.checked)} />
          <span>Hands-off (auto-approve &amp; merge)</span>
        </label>
        {missing.length > 0 && <div className="warnmsg">{missing.join(". ")}. Select the blocker too, or the work starts without it.</div>}
        <button className="primary" disabled={picked.size === 0} onClick={start}>
          Run {picked.size || ""} issue{picked.size === 1 ? "" : "s"}
        </button>
      </div>
    </aside>
  );
}
