import { useEffect, useRef, useState } from "react";
import { api, connectEvents, NEEDS_YOU, STATUS_LABEL, waitingFor, type Run, type Config } from "./api";
import { IssuesPanel } from "./IssuesPanel";
import { RunCard } from "./RunCard";
import { RunDetail } from "./RunDetail";
import { PipelineEditor } from "./PipelineEditor";
import { SpecsPage } from "./SpecsPage";

export function App() {
  const [repo, setRepo] = useState("");
  const [demo, setDemo] = useState(false);
  const [config, setConfig] = useState<Config | null>(null);
  const [runs, setRuns] = useState<Record<string, Run>>({});
  const [closed, setClosed] = useState<number[]>([]); // issues the engine knows are closed
  const [tab, setTab] = useState<"runs" | "pipeline">("runs");
  const [selected, setSelected] = useState<string | null>(() => new URLSearchParams(location.search).get("run"));
  const [live, setLive] = useState(false);
  // The Specs page is the hash route #/specs or #/specs/<spec number>.
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const onHash = () => setHash(location.hash);
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);
  const specRoute = hash.match(/^#\/specs(?:\/(\d+))?/);
  const showTab = (t: "runs" | "pipeline") => { if (specRoute) location.hash = ""; setTab(t); };

  useEffect(() => {
    // Live updates that arrive while a state request runs wait for it, then apply on top.
    // A run is never replaced by an older copy of itself, and only the newest request counts.
    let gen = 0;
    let queue: (() => void)[] | null = null;
    const newer = (old: Run | undefined, r: Run) => (!old || r.updatedAt >= old.updatedAt ? r : old);
    const flush = () => { const q = queue ?? []; queue = null; q.forEach((f) => f()); };
    const live = (f: () => void) => (queue ? queue.push(f) : f());
    const load = () => {
      const my = ++gen;
      queue ??= [];
      api.state().then((s) => {
        if (my !== gen) return;
        setRepo(s.repo); setDemo(s.demo); setConfig(s.config); setClosed(s.closed ?? []);
        setRuns((m) => Object.fromEntries(s.runs.map((r) => [r.id, newer(m[r.id], r)])));
        flush();
      }, () => { if (my === gen) flush(); });
    };
    load();
    // After a reconnect, run updates sent meanwhile were missed: load the state again.
    let opened = false;
    return connectEvents({
      run: (r) => live(() => setRuns((m) => ({ ...m, [r.id]: newer(m[r.id], r) }))),
      removed: (id) => live(() => setRuns((m) => { const n = { ...m }; delete n[id]; return n; })),
      config: setConfig,
      closed: setClosed,
      status: (ok) => { setLive(ok); if (ok && opened) load(); if (ok) opened = true; },
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
          <button className={!specRoute && tab === "runs" ? "on" : ""} onClick={() => showTab("runs")}>Runs</button>
          <button className={!specRoute && tab === "pipeline" ? "on" : ""} onClick={() => showTab("pipeline")}>Pipeline</button>
          <a className={specRoute ? "on" : ""} href={`${location.pathname}#/specs`} target="_blank" rel="noopener" title="Open the Specs page in a new window">Specs ↗</a>
        </nav>
        <div className="meta">
          <span>{running} running</span>
          {attention > 0 && <span className="pill warn">{attention} need you</span>}
          {notify === "default" && <button className="ghost small" title="Get a desktop notification when a run needs you" onClick={() => Notification.requestPermission().then(setNotify)}>🔔 Notify me</button>}
          <span className="repo" title={repo}>{repo.split("/").slice(-2).join("/")}</span>
          <span className={`dot ${live ? "ok" : "bad"}`} title={live ? "live" : "disconnected"} />
        </div>
      </header>

      {specRoute ? (
        <SpecsPage spec={specRoute[1] ? Number(specRoute[1]) : undefined} refreshKey={list.map((r) => `${r.id}:${r.status}`).join()} config={config} run={sel} onOpenRun={setSelected} onCloseRun={() => setSelected(null)} />
      ) : tab === "pipeline" ? (
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
              <div className="cards">{list.map((r) => <RunCard key={r.id} run={r} waiting={r.status === "queued" ? waitingFor(r, list, closed) : []} onOpen={() => setSelected(r.id)} />)}</div>
            )}
          </section>
        </main>
      )}
    </div>
  );
}
