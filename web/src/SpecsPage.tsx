import { useEffect, useState } from "react";
import { api, NODE_LABEL, type Config, type Issue, type Run, type SpecGraph } from "./api";
import { Markdown } from "./Markdown";
import { RunDetail } from "./RunDetail";

const W = 220, H = 62, GAP_X = 72, GAP_Y = 16;

/** Tickets in columns by depth, with an arrow from each blocker to the ticket it blocks. */
function Graph({ graph, onOpenRun }: { graph: SpecGraph; onOpenRun: (id: string) => void }) {
  const rows = new Map<number, number>(); // depth → nodes placed in that column so far
  const pos = new Map<number, { x: number; y: number }>();
  for (const n of [...graph.nodes].sort((a, b) => a.number - b.number)) {
    const row = rows.get(n.depth) ?? 0;
    rows.set(n.depth, row + 1);
    pos.set(n.number, { x: n.depth * (W + GAP_X), y: row * (H + GAP_Y) });
  }
  const width = rows.size * (W + GAP_X) - GAP_X;
  const height = Math.max(...rows.values()) * (H + GAP_Y) - GAP_Y;
  return (
    <div className="graph-scroll">
      <div className="graph" style={{ width, height }}>
        <svg width={width} height={height} aria-hidden="true">
          <defs><marker id="arrowhead" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 8 4 0 8z" /></marker></defs>
          {graph.edges.map((e) => {
            const a = pos.get(e.from)!, b = pos.get(e.to)!;
            const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x, y2 = b.y + H / 2, bend = Math.max(GAP_X / 2, (x2 - x1) / 2);
            return <path key={`${e.from}-${e.to}`} d={`M${x1} ${y1} C${x1 + bend} ${y1} ${x2 - bend} ${y2} ${x2} ${y2}`} markerEnd="url(#arrowhead)" />;
          })}
        </svg>
        {graph.nodes.map((n) => (
          <button key={n.number} className={`gnode st-${n.status}`} style={{ left: pos.get(n.number)!.x, top: pos.get(n.number)!.y, width: W, height: H }}
            disabled={!n.runId} onClick={() => n.runId && onOpenRun(n.runId)} title={`#${n.number} ${n.title}\n${NODE_LABEL[n.status]}${n.runId ? " · open the run" : ""}`}>
            <span className="gnode-top"><span className="num">#{n.number}</span><span className="gnode-status">{NODE_LABEL[n.status]}</span></span>
            <span className="gnode-title">{n.title}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function SpecsPage({ spec, refreshKey, config, onOpenRun, onCloseRun, run }: {
  spec?: number; refreshKey: string; config: Config; run?: Run; onOpenRun: (id: string) => void; onCloseRun: () => void;
}) {
  const [specs, setSpecs] = useState<Issue[] | null>(null);
  const [listErr, setListErr] = useState("");
  const [graph, setGraph] = useState<SpecGraph | null>(null);
  const [graphErr, setGraphErr] = useState("");
  const [reload, setReload] = useState(0);

  useEffect(() => { setListErr(""); api.specs().then(setSpecs, (e) => setListErr(e.message)); }, [reload]);
  // No spec in the URL: show the first one.
  useEffect(() => { if (!spec && specs?.length) location.replace(`#/specs/${specs[0].number}`); }, [spec, specs]);
  // Load the graph again when a run changes status, so the nodes follow the Runs view.
  // ponytail: every reload asks GitHub again. Cache the tickets in the engine if this gets slow.
  useEffect(() => {
    if (!spec) return;
    let stale = false;
    api.spec(spec).then((g) => { if (!stale) { setGraph(g); setGraphErr(""); } }, (e) => { if (!stale) setGraphErr(e.message); });
    return () => { stale = true; };
  }, [spec, refreshKey, reload]);
  const shown = graph?.number === spec ? graph : null;

  return (
    <main className="runs-layout">
      <aside className="issues">
        <div className="issues-head">
          <h3>Open specs</h3>
          <button className="ghost small" onClick={() => setReload((n) => n + 1)} title="Reload">↻</button>
        </div>
        <div className="issue-list">
          {listErr && <div className="error">{listErr}</div>}
          {!specs && !listErr && <div className="muted pad">Loading specs…</div>}
          {specs?.length === 0 && <div className="muted pad">No open issues with the <code>spec</code> label.</div>}
          {specs?.map((s) => (
            <a key={s.number} className={`issue spec ${s.number === spec ? "picked" : ""}`} href={`#/specs/${s.number}`} onClick={onCloseRun}>
              <span className="num">#{s.number}</span><span className="title">{s.title}</span>
            </a>
          ))}
        </div>
      </aside>
      <section className="runs-main">
        {run ? <RunDetail run={run} config={config} onBack={onCloseRun} /> : (
          <div className="spec-page">
            {graphErr && <div className="error">{graphErr}</div>}
            {spec && !shown && !graphErr && <div className="muted">Loading spec #{spec}…</div>}
            {shown && <>
              <h2><span className="num">#{shown.number}</span> {shown.title}</h2>
              {shown.nodes.length ? <Graph graph={shown} onOpenRun={onOpenRun} /> : <div className="muted">This spec has no tickets yet. Add sub-issues, or a <code>Part of #{shown.number}</code> line to an issue.</div>}
              {shown.nodes.length > 0 && <p className="muted small-note">Arrows go from a blocker to the ticket it blocks. Click a ticket that has a run to open it.</p>}
              <div className="spec-body">{shown.body.trim() ? <Markdown text={shown.body} /> : <span className="muted">This spec has no description.</span>}</div>
            </>}
          </div>
        )}
      </section>
    </main>
  );
}
