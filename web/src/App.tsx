import { useEffect, useRef, useState } from "react";
import { api, connectEvents, NEEDS_YOU, STATUS_LABEL, waitingFor, type Run, type Config } from "./api";
import { IssuesPanel } from "./IssuesPanel";
import { RunCard } from "./RunCard";
import { RunDetail } from "./RunDetail";
import { PipelineEditor } from "./PipelineEditor";

export function App() {
  const [repo, setRepo] = useState("");
  const [demo, setDemo] = useState(false);
  const [config, setConfig] = useState<Config | null>(null);
  const [runs, setRuns] = useState<Record<string, Run>>({});
  const [tab, setTab] = useState<"runs" | "pipeline">("runs");
  const [selected, setSelected] = useState<string | null>(() => new URLSearchParams(location.search).get("run"));
  const [live, setLive] = useState(false);

  useEffect(() => {
    api.state().then((s) => {
      setRepo(s.repo); setDemo(s.demo); setConfig(s.config);
      setRuns(Object.fromEntries(s.runs.map((r) => [r.id, r])));
    });
    return connectEvents({
      run: (r) => setRuns((m) => ({ ...m, [r.id]: r })),
      removed: (id) => setRuns((m) => { const n = { ...m }; delete n[id]; return n; }),
      config: setConfig,
      status: setLive,
    });
  }, []);

  useEffect(() => {
    const u = new URL(location.href);
    selected ? u.searchParams.set("run", selected) : u.searchParams.delete("run");
    history.replaceState(null, "", u);
  }, [selected]);

  const list = Object.values(runs).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const needYou = list.filter((r) => NEEDS_YOU.includes(r.status));
  const attention = needYou.length;
  const [notify, setNotify] = useState(() => ("Notification" in window ? Notification.permission : "denied"));
  const lastAttention = useRef(0);
  useEffect(() => {
    document.title = attention ? `(${attention}) loopsmith` : "loopsmith";
    if (attention > lastAttention.current && document.hidden && notify === "granted") {
      const r = [...needYou].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
      new Notification("loopsmith needs you", { body: `#${r.issue.number} ${r.issue.title}: ${STATUS_LABEL[r.status]}` });
    }
    lastAttention.current = attention;
  }, [attention]);
  const running = list.filter((r) => r.status === "running").length;
  const sel = selected ? runs[selected] : undefined;

  if (!config) return <div className="boot">Loading…</div>;

  return (
    <div className="app">
      <header className="top">
        <div className="brand"><span className="logo">⟳</span> loopsmith {demo && <span className="pill demo">demo</span>}</div>
        <nav>
          <button className={tab === "runs" ? "on" : ""} onClick={() => setTab("runs")}>Runs</button>
          <button className={tab === "pipeline" ? "on" : ""} onClick={() => setTab("pipeline")}>Pipeline</button>
        </nav>
        <div className="meta">
          <span>{running} running</span>
          {attention > 0 && <span className="pill warn">{attention} need you</span>}
          {notify === "default" && <button className="ghost small" title="Get a desktop notification when a run needs you" onClick={() => Notification.requestPermission().then(setNotify)}>🔔 Notify me</button>}
          <span className="repo" title={repo}>{repo.split("/").slice(-2).join("/")}</span>
          <span className={`dot ${live ? "ok" : "bad"}`} title={live ? "live" : "disconnected"} />
        </div>
      </header>

      {tab === "pipeline" ? (
        <PipelineEditor config={config} onSaved={setConfig} />
      ) : (
        <main className="runs-layout">
          <IssuesPanel runs={list} onStarted={(r) => r[0] && setSelected(r[0].id)} />
          <section className="runs-main">
            {sel ? (
              <RunDetail run={sel} config={config} onBack={() => setSelected(null)} />
            ) : list.length === 0 ? (
              <div className="empty">
                <h2>No runs yet</h2>
                <p>Select issues on the left and press <b>Run</b>. Each issue gets its own worktree and goes through the pipeline:</p>
                <p className="flow">{config.pipeline.map((s) => s.name ?? s.id).join("  →  ")}</p>
              </div>
            ) : (
              <div className="cards">{list.map((r) => <RunCard key={r.id} run={r} waiting={r.status === "queued" ? waitingFor(r, list) : []} onOpen={() => setSelected(r.id)} />)}</div>
            )}
          </section>
        </main>
      )}
    </div>
  );
}
