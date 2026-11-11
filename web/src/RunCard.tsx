import { STATUS_LABEL, ago, totalCost, type Run } from "./api";

export function stageState(run: Run, stageId: string) {
  const steps = run.steps.filter((s) => s.stageId === stageId);
  const last = steps.at(-1);
  return { count: steps.length, status: last?.status ?? "pending", current: run.currentStageId === stageId && ["running", "waiting_approval", "waiting_input"].includes(run.status) };
}

export function scores(run: Run) {
  return run.steps.filter((s) => s.vars?.score !== undefined).map((s) => Number(s.vars!.score));
}

export function Stepper({ run, onPick, selected }: { run: Run; onPick?: (stageId: string) => void; selected?: string }) {
  return (
    <div className="stepper">
      {run.pipeline.map((s, i) => {
        const st = stageState(run, s.id);
        return (
          <div key={s.id} className="step-wrap">
            {i > 0 && <span className="arrow">›</span>}
            <button className={`chip ${st.status} ${st.current ? "current" : ""} ${selected === s.id ? "sel" : ""}`} onClick={() => onPick?.(s.id)} title={`${s.name ?? s.id}: ${st.status}`}>
              {s.name ?? s.id}
              {st.count > 1 && <span className="count">×{st.count}</span>}
            </button>
          </div>
        );
      })}
    </div>
  );
}

export function ScoreTrail({ run }: { run: Run }) {
  const sc = scores(run);
  if (!sc.length) return null;
  return (
    <span className="scores" title="Review scores">
      {sc.map((v, i) => <span key={i} className={`score ${v >= 8 ? "good" : v >= 6 ? "mid" : "bad"}`}>{v}</span>)}
    </span>
  );
}

export function RunCard({ run, waiting = [], onOpen }: { run: Run; waiting?: number[]; onOpen: () => void }) {
  const current = run.pipeline.find((s) => s.id === run.currentStageId);
  return (
    <div className={`card status-${run.status}`} onClick={onOpen}>
      <div className="card-top">
        <span className="num">#{run.issue.number}</span>
        <span className="card-title">{run.issue.title}</span>
        <span className={`badge ${run.status}`}>{STATUS_LABEL[run.status]}</span>
      </div>
      <Stepper run={run} />
      <div className="card-foot">
        {current && run.status === "running" && <span>▶ {current.name ?? current.id}</span>}
        {run.pr && <a href={run.pr.url} target="_blank" onClick={(e) => e.stopPropagation()}>PR #{run.pr.number}</a>}
        <ScoreTrail run={run} />
        {waiting.length > 0 && <span className="muted">waits for {waiting.map((n) => `#${n}`).join(", ")}</span>}
        {totalCost(run) > 0 && <span className="muted">${totalCost(run).toFixed(2)}</span>}
        {run.options.autoApprove && <span className="muted">hands-off</span>}
        <span className="muted right">{ago(run.updatedAt)}</span>
      </div>
      {run.error && <div className="card-error">{run.error}</div>}
    </div>
  );
}
