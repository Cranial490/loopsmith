import { useEffect, useRef, useState } from "react";
import { api, onLog, STATUS_LABEL, duration, totalCost, type Run, type Config } from "./api";
import { Stepper, ScoreTrail } from "./RunCard";
import { LogFormatter, type Block, type Chunk } from "./format";
import { Markdown } from "./Markdown";

export function RunDetail({ run, config, onBack }: { run: Run; config: Config; onBack: () => void }) {
  const [stepIdx, setStepIdx] = useState<number | null>(null);
  const [follow, setFollow] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [notes, setNotes] = useState("");
  const [answer, setAnswer] = useState("");
  const idle = !["running", "queued"].includes(run.status);

  // Follow the newest step while the run moves, unless the user picked one.
  const shownIdx = follow || stepIdx === null ? run.steps.length - 1 : stepIdx;
  const step = run.steps[shownIdx];

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true); setErr("");
    try { await fn(); } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };

  const pickStage = (id: string) => {
    const s = [...run.steps].reverse().find((x) => x.stageId === id);
    if (s) { setStepIdx(s.index); setFollow(false); }
  };

  const harnessOf = (h?: string) => (h ? config.harnesses[h]?.label ?? h : "");

  return (
    <div className="detail">
      <div className="detail-head">
        <button className="ghost" onClick={onBack}>← All runs</button>
        <h2><span className="num">#{run.issue.number}</span> {run.issue.title}</h2>
        <span className={`badge ${run.status}`}>{STATUS_LABEL[run.status]}</span>
      </div>
      <div className="detail-sub">
        <code>{run.branch}</code>
        {run.pr && <a href={run.pr.url} target="_blank">PR #{run.pr.number} ↗</a>}
        {run.issue.url && <a href={run.issue.url} target="_blank">Issue ↗</a>}
        <ScoreTrail run={run} />
        {totalCost(run) > 0 && <span className="muted">cost ${totalCost(run).toFixed(2)}</span>}
        <span className="muted">{run.options.autoApprove ? "hands-off" : "approval required"}</span>
        <span className="muted" title={run.worktree}>worktree: {run.worktree.split("/").slice(-2).join("/")}</span>
        <div className="actions">
          {["running", "queued", "waiting_approval", "waiting_input"].includes(run.status) && <button className="danger" disabled={busy} onClick={() => act(() => api.stop(run.id))}>Stop</button>}
          {["failed", "stopped", "interrupted"].includes(run.status) && <button disabled={busy} onClick={() => act(() => api.resume(run.id))}>Resume at "{run.pipeline.find((s) => s.id === run.currentStageId)?.name ?? run.currentStageId}"</button>}
          {run.status === "needs_attention" && <button disabled={busy} onClick={() => act(() => api.resume(run.id, true))}>Resume (reset loop limits)</button>}
          {idle && run.steps.length > 0 && (
            <select className="from" value="" disabled={busy} title="Run again from a stage you choose" onChange={(e) => e.target.value && act(() => api.resume(run.id, true, e.target.value))}>
              <option value="">Run from stage…</option>
              {run.pipeline.map((s) => <option key={s.id} value={s.id}>{s.name ?? s.id}</option>)}
            </select>
          )}
          {!["running", "queued", "waiting_approval", "waiting_input"].includes(run.status) && <button className="ghost" disabled={busy} onClick={() => confirm("Delete this run and its logs?") && act(async () => { await api.remove(run.id); onBack(); })}>Delete</button>}
        </div>
      </div>

      <Stepper run={run} onPick={pickStage} selected={step?.stageId} />

      {run.status === "waiting_approval" && (
        <div className="approval">
          <div>
            <b>Waiting for you.</b> {run.steps.at(-1)?.note}
          </div>
          <div className="actions">
            <button className="primary" disabled={busy} onClick={() => act(() => api.approve(run.id))}>Approve &amp; continue</button>
            <button className="danger" disabled={busy} onClick={() => act(() => api.reject(run.id))}>Reject</button>
          </div>
          <div className="sendback">
            <textarea rows={2} placeholder="Not good enough yet? Write what must change. The fix agent gets your notes, then the review runs again." value={notes} onChange={(e) => setNotes(e.target.value)} />
            <button disabled={busy || !notes.trim()} onClick={() => act(async () => { await api.sendBack(run.id, notes); setNotes(""); })}>Send back with notes</button>
          </div>
        </div>
      )}
      {run.status === "waiting_input" && (
        <div className="approval question">
          <div><b>{run.steps.at(-1)?.stageName} has questions for you.</b> The agent stopped. It continues in the same session when you answer.</div>
          <pre className="qtext">{run.steps.at(-1)?.question}</pre>
          <div className="sendback">
            <textarea rows={4} autoFocus placeholder="Your answers (for example: 1. SQLite. 2. Yes, required.)" value={answer} onChange={(e) => setAnswer(e.target.value)} />
            <button className="primary" disabled={busy || !answer.trim()} onClick={() => act(async () => { await api.answer(run.id, answer); setAnswer(""); })}>Send answer &amp; continue</button>
          </div>
        </div>
      )}
      {run.error && <div className="error">{run.error}</div>}
      {err && <div className="error">{err}</div>}

      <div className="detail-body">
        <ol className="timeline">
          {run.steps.map((s) => (
            <li key={s.index} className={`${s.status} ${s.index === shownIdx ? "sel" : ""}`} onClick={() => { setStepIdx(s.index); setFollow(s.index === run.steps.length - 1); }}>
              <span className={`sdot ${s.status}`} />
              <div>
                <div className="t-name">{s.stageName}{s.attempt > 1 && <span className="muted"> · round {s.attempt}</span>}</div>
                <div className="t-meta">
                  {harnessOf(s.harness) || s.type}
                  {" · "}{s.status === "waiting" ? "waiting" : duration(s.startedAt, s.endedAt)}
                  {s.vars?.score !== undefined && <> · <b>score {s.vars.score}</b></>}
                  {s.question && <span className="handoff-mark" title={s.answer ? `Q: ${s.question}\n\nA: ${s.answer}` : s.question}> · asked you</span>}
                  {s.handoff && <span className="handoff-mark" title="Wrote a handoff note"> · note</span>}
                </div>
              </div>
            </li>
          ))}
          {run.status === "queued" && <li className="queued"><span className="sdot" /><div className="t-name muted">queued…</div></li>}
        </ol>
        {step ? <StepView run={run} index={shownIdx} harness={harnessOf(step.harness)} follow={follow} setFollow={setFollow} /> : <div className="muted pad">Not started yet.</div>}
      </div>
    </div>
  );
}

function StepView({ run, index, harness, follow, setFollow }: { run: Run; index: number; harness: string; follow: boolean; setFollow: (b: boolean) => void }) {
  const step = run.steps[index];
  const [view, setView] = useState<"log" | "prompt" | "output" | "handoff">("log");
  const [raw, setRaw] = useState(false);
  const [, setTick] = useState(0);
  const log = useRef({ chunks: [] as Chunk[], fmt: new LogFormatter() });
  const ref = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);

  useEffect(() => {
    let cancelled = false, loaded = false;
    log.current = { chunks: [], fmt: new LogFormatter() };
    setTick((t) => t + 1);
    const add = (c: Chunk) => { log.current.chunks.push(c); log.current.fmt.push(c); };
    api.log(run.id, index).then((cs) => { if (cancelled) return; cs.forEach(add); loaded = true; setTick((t) => t + 1); });
    // Live chunks that arrive before the saved log loads are already in it.
    const off = onLog((e) => { if (loaded && e.runId === run.id && e.index === index) { add({ s: e.s, t: e.t }); setTick((t) => t + 1); } });
    return () => { cancelled = true; off(); };
  }, [run.id, index]);

  // Follow the newest output, unless the user scrolled up to read.
  useEffect(() => {
    const el = ref.current;
    if (el && view === "log" && follow && atBottom.current) el.scrollTop = el.scrollHeight;
  });

  const rawLog = () => log.current.chunks.map((c) => c.t).join("");
  const text = view === "prompt" ? step.prompt : view === "handoff" ? step.handoff : view === "output" ? step.output : undefined;

  return (
    <div className="stepview">
      <div className="step-head">
        <div>
          <b>{step.stageName}</b> <span className={`badge ${step.status}`}>{step.status}</span>
          {step.note && <span className="muted"> · {step.note}</span>}
        </div>
        <div className="tabs">
          {(["log", "prompt", "output", "handoff"] as const).map((v) => (
            <button key={v} className={view === v ? "on" : ""} disabled={(v === "prompt" && !step.prompt) || (v === "handoff" && !step.handoff)} onClick={() => setView(v)}>{v}</button>
          ))}
          <span className="sep" />
          <button className={raw ? "" : "on"} onClick={() => setRaw(false)} title="Readable view">formatted</button>
          <button className={raw ? "on" : ""} onClick={() => setRaw(true)} title="The original output, unchanged">raw</button>
          <CopyButton text={() => (view === "log" ? rawLog() : text ?? "")} label="copy raw" />
          <label className="follow"><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> follow</label>
        </div>
      </div>
      <div className="step-meta">
        {harness && <span>harness: <b>{harness}</b></span>}
        {step.exitCode !== undefined && <span>exit: {String(step.exitCode)}</span>}
        {step.costUsd !== undefined && <span>cost: ${step.costUsd.toFixed(2)}</span>}
        {step.sessionId && <span title={step.sessionId}>session: {step.sessionId.slice(0, 8)}</span>}
        <span>time: {duration(step.startedAt, step.endedAt)}</span>
        {step.vars && Object.entries(step.vars).map(([k, v]) => <span key={k}>{k}: <b>{String(v)}</b></span>)}
        {step.command && <code className="cmd" title={step.command}>{step.command}</code>}
      </div>
      <div ref={ref} className="log" onScroll={(e) => { const el = e.currentTarget; atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}>
        {view === "log"
          ? raw
            ? <pre className="raw">{log.current.chunks.map((c, i) => <span key={i} className={c.s}>{c.t}</span>)}</pre>
            : <LogBlocks blocks={log.current.fmt.blocks()} running={step.status === "running"} />
          : !text
            ? <span className="muted">{view === "output" ? "(no output yet)" : ""}</span>
            : raw || view === "prompt" ? <pre className="raw">{text}</pre> : <Markdown text={text} />}
      </div>
    </div>
  );
}

function CopyButton({ text, label = "copy" }: { text: () => string; label?: string }) {
  const [done, setDone] = useState(false);
  return <button className="copy" onClick={(e) => { e.preventDefault(); navigator.clipboard?.writeText(text()).then(() => { setDone(true); setTimeout(() => setDone(false), 1200); }); }}>{done ? "copied" : label}</button>;
}

function Full({ label, text }: { label: string; text: string }) {
  return (
    <div className="full">
      <div className="full-head"><span>{label}</span><CopyButton text={() => text} /></div>
      <pre>{text}</pre>
    </div>
  );
}

function LogBlocks({ blocks, running }: { blocks: Block[]; running: boolean }) {
  if (!blocks.length) return <span className="muted">…</span>;
  return (
    <>
      {blocks.map((b, i) => {
        switch (b.kind) {
          case "message": return <div key={i} className="blk msg"><div className="lbl">Agent</div><Markdown text={b.text} /></div>;
          case "thinking": return b.text.trim() ? <details key={i} className="blk thinking"><summary>Thinking · {b.text.trim().split("\n")[0].replace(/\*/g, "").slice(0, 100)}</summary><Markdown text={b.text} /></details> : null;
          case "tool": {
            const state = b.error ? "bad" : b.result !== undefined ? "ok" : "";
            return (
              <details key={i} className={`blk tool ${state}`}>
                <summary><span className="lbl">{b.name}</span><code>{b.summary}</code><span className="state">{b.error ? "✗ failed" : b.result !== undefined ? "✓" : running && i === blocks.length - 1 ? "…" : ""}</span></summary>
                <Full label={b.name === "Command" || b.name === "Shell" || b.name === "Bash" ? "Command" : "Input"} text={b.detail} />
                {b.result !== undefined && <Full label="Result" text={b.result || "(empty)"} />}
              </details>
            );
          }
          case "output": return <pre key={i} className="blk out">{b.text.replace(/\n+$/, "")}</pre>;
          case "error": return (
            <div key={i} className="blk err">
              <div className="lbl">Error</div>
              <div className="err-title">{b.title}</div>
              {b.detail && b.detail !== b.title && <details><summary>Details</summary><Full label="Diagnostics" text={b.detail} /></details>}
            </div>
          );
          case "warn": return <div key={i} className="blk warn"><span className="lbl">Warning</span> {b.text}</div>;
          case "system": return <div key={i} className="blk sys">{b.text}</div>;
          case "noise": return b.lines.length ? <details key={i} className="blk noise"><summary>{b.title} · {b.lines.length} line{b.lines.length > 1 ? "s" : ""}</summary><pre>{b.lines.join("\n")}</pre></details> : null;
          case "done": return (
            <div key={i} className="blk done">
              <span className="lbl">Done</span> {b.title}
              {b.text && <details><summary>Final answer</summary><Markdown text={b.text} /></details>}
            </div>
          );
        }
      })}
    </>
  );
}
