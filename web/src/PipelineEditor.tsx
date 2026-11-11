import { useEffect, useState } from "react";
import { api, type Config, type Stage, type HarnessConfig } from "./api";

const VARS = ["handoff", "issue.number", "issue.title", "issue.body", "branch", "baseBranch", "pr.number", "pr.url", "iteration", "vars.<name>", "stages.<id>.output"];

export function PipelineEditor({ config, onSaved }: { config: Config; onSaved: (c: Config) => void }) {
  const [draft, setDraft] = useState<Config>(() => structuredClone(config));
  const [sel, setSel] = useState<string>(config.pipeline[0]?.id);
  const [raw, setRaw] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const dirty = JSON.stringify(draft) !== JSON.stringify(config);

  useEffect(() => { if (!dirty) setDraft(structuredClone(config)); }, [config]);

  const setStage = (id: string, patch: Partial<Stage>) =>
    setDraft((d) => ({ ...d, pipeline: d.pipeline.map((s) => (s.id === id ? ({ ...s, ...patch } as Stage) : s)) }));

  const renameStage = (oldId: string, newId: string) => {
    setDraft((d) => ({
      ...d,
      pipeline: d.pipeline.map((s) => ({
        ...(s.id === oldId ? { ...s, id: newId } : s),
        next: s.next?.map((t) => (t.goto === oldId ? { ...t, goto: newId } : t)),
      })) as Stage[],
    }));
    setSel(newId);
  };

  const addStage = (type: Stage["type"]) => {
    let id = type === "agent" ? "agent" : type, n = 1;
    while (draft.pipeline.some((s) => s.id === id)) id = `${type}-${++n}`;
    const base = { id, name: id };
    const stage: Stage =
      type === "agent" ? { ...base, type, harness: Object.keys(draft.harnesses)[0], prompt: "Work on PR #{{pr.number}} for issue #{{issue.number}}." }
      : type === "shell" ? { ...base, type, command: "npm test" }
      : { ...base, type, message: "Check the PR, then approve." };
    const i = draft.pipeline.findIndex((s) => s.id === sel);
    const pipeline = [...draft.pipeline];
    pipeline.splice(i + 1, 0, stage);
    setDraft({ ...draft, pipeline });
    setSel(id);
  };

  const move = (id: string, dir: -1 | 1) => {
    const p = [...draft.pipeline];
    const i = p.findIndex((s) => s.id === id), j = i + dir;
    if (j < 0 || j >= p.length) return;
    [p[i], p[j]] = [p[j], p[i]];
    setDraft({ ...draft, pipeline: p });
  };

  const del = (id: string) => {
    const p = draft.pipeline.filter((s) => s.id !== id);
    setDraft({ ...draft, pipeline: p });
    setSel(p[0]?.id);
  };

  const save = async () => {
    setMsg(null);
    try {
      const cfg = raw !== null ? JSON.parse(raw) : draft;
      const saved = await api.saveConfig(cfg);
      onSaved(saved); setDraft(structuredClone(saved)); setRaw(null);
      setMsg({ ok: true, text: "Saved. New runs use this pipeline. Runs already started keep their own copy." });
    } catch (e: any) { setMsg({ ok: false, text: e.message }); }
  };

  const stage = draft.pipeline.find((s) => s.id === sel);
  const ids = draft.pipeline.map((s) => s.id);

  return (
    <main className="pipeline">
      <div className="pipe-bar">
        <h2>Pipeline</h2>
        <span className="muted">Stages run top to bottom. A stage can jump to another stage with rules (that is how loops work).</span>
        <div className="actions">
          <button className="ghost" onClick={() => setRaw(raw === null ? JSON.stringify(draft, null, 2) : null)}>{raw === null ? "Edit JSON" : "Visual editor"}</button>
          <button className="ghost" disabled={!dirty && raw === null} onClick={() => { setDraft(structuredClone(config)); setRaw(null); }}>Discard</button>
          <button className="ghost" onClick={async () => { if (confirm("Load the default pipeline? (not saved until you press Save)")) setDraft(await api.defaultConfig()); }}>Defaults</button>
          <button className="primary" disabled={!dirty && raw === null} onClick={save}>Save</button>
        </div>
      </div>
      {msg && <div className={msg.ok ? "okmsg" : "error"} style={{ whiteSpace: "pre-wrap" }}>{msg.text}</div>}

      {raw !== null ? (
        <textarea className="raw" value={raw} onChange={(e) => setRaw(e.target.value)} spellCheck={false} />
      ) : (
        <div className="pipe-grid">
          <div className="flow">
            {draft.pipeline.map((s, i) => (
              <div key={s.id}>
                <div className={`node ${s.type} ${sel === s.id ? "sel" : ""}`} onClick={() => setSel(s.id)}>
                  <div className="node-top">
                    <span className="node-type">{s.type}</span>
                    <span className="node-name">{s.name ?? s.id}</span>
                    {s.type === "agent" && <span className="pill">{draft.harnesses[s.harness]?.label ?? s.harness}</span>}
                  </div>
                  {s.type === "agent" && (
                    <select value={s.harness} onClick={(e) => e.stopPropagation()} onChange={(e) => setStage(s.id, { harness: e.target.value } as any)}>
                      {Object.entries(draft.harnesses).map(([k, h]) => <option key={k} value={k}>{h.label ?? k}</option>)}
                    </select>
                  )}
                  {s.next?.map((t, k) => (
                    <div key={k} className="rule">{t.when ? <>if <code>{t.when}</code></> : "else"} → <b>{t.goto}</b></div>
                  ))}
                  {s.maxRuns && <div className="rule muted">max {s.maxRuns} runs</div>}
                </div>
                {i < draft.pipeline.length - 1 && <div className="down">↓</div>}
              </div>
            ))}
            <div className="add-row">
              <span className="muted">Add after selected:</span>
              <button className="ghost small" onClick={() => addStage("agent")}>+ agent</button>
              <button className="ghost small" onClick={() => addStage("shell")}>+ shell</button>
              <button className="ghost small" onClick={() => addStage("approval")}>+ approval</button>
            </div>
          </div>

          <div className="editor">
            {stage ? (
              <StageForm key={stage.id} stage={stage} ids={ids} harnesses={draft.harnesses}
                onChange={(p) => setStage(stage.id, p)} onRename={(n) => renameStage(stage.id, n)}
                onMove={(d) => move(stage.id, d)} onDelete={() => del(stage.id)} />
            ) : <div className="muted">Select a stage.</div>}
            <HarnessesForm harnesses={draft.harnesses} onChange={(h) => setDraft({ ...draft, harnesses: h })} />
            <div className="section">
              <h4>Settings</h4>
              <div className="grid2">
                <label>Base branch<input value={draft.baseBranch} onChange={(e) => setDraft({ ...draft, baseBranch: e.target.value })} /></label>
                <label>Max parallel runs<input type="number" min={1} value={draft.maxParallel} onChange={(e) => setDraft({ ...draft, maxParallel: Number(e.target.value) })} /></label>
                <label>Worktree folder<input value={draft.worktreeDir} onChange={(e) => setDraft({ ...draft, worktreeDir: e.target.value })} /></label>
                <label>Branch prefix<input value={draft.branchPrefix} onChange={(e) => setDraft({ ...draft, branchPrefix: e.target.value })} /></label>
              </div>
              <div className="grid2">
                <label>Setup command for each new worktree<input placeholder="npm ci" value={draft.setupCommand ?? ""} onChange={(e) => setDraft({ ...draft, setupCommand: e.target.value })} /></label>
                <label>Untracked files to copy into each worktree<input placeholder=".env, .env.local" value={(draft.copyFiles ?? []).join(", ")} onChange={(e) => setDraft({ ...draft, copyFiles: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })} /></label>
              </div>
              <label className="check"><input type="checkbox" checked={draft.holdQueueOnProblem !== false} onChange={(e) => setDraft({ ...draft, holdQueueOnProblem: e.target.checked })} /> Hold the queue when a run fails or needs attention</label>
              <label className="check"><input type="checkbox" checked={draft.removeWorktreeWhenDone} onChange={(e) => setDraft({ ...draft, removeWorktreeWhenDone: e.target.checked })} /> Remove worktree when a run is done</label>
              <label>Handoff note instructions (added to the end of each agent prompt that writes a note; <code>{"{{handoffFile}}"}</code> is the file path)
                <textarea rows={9} value={draft.handoffInstructions} onChange={(e) => setDraft({ ...draft, handoffInstructions: e.target.value })} spellCheck={false} /></label>
              <label>Question instructions (added when an agent may ask you questions; <code>{"{{questionFile}}"}</code> is the file path)
                <textarea rows={7} value={draft.questionInstructions ?? ""} onChange={(e) => setDraft({ ...draft, questionInstructions: e.target.value })} spellCheck={false} /></label>
              <label>Max characters of earlier notes given to the next agent (oldest dropped first)
                <input type="number" min={500} value={draft.handoffMaxChars} onChange={(e) => setDraft({ ...draft, handoffMaxChars: Number(e.target.value) })} /></label>
              <p className="hint">Earlier notes go at the top of the prompt. To place them yourself, put <code>{"{{handoff}}"}</code> in the prompt.</p>
              <p className="hint">Keep max parallel at 1 if issues build on each other: each new worktree then starts from the freshly merged base branch.</p>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

function StageForm({ stage, ids, harnesses, onChange, onRename, onMove, onDelete }: {
  stage: Stage; ids: string[]; harnesses: Record<string, HarnessConfig>;
  onChange: (p: Partial<Stage>) => void; onRename: (id: string) => void; onMove: (d: -1 | 1) => void; onDelete: () => void;
}) {
  const [idDraft, setIdDraft] = useState(stage.id);
  const next = stage.next ?? [];
  const setNext = (n: typeof next) => onChange({ next: n.length ? n : undefined });
  const extract = Object.entries((stage as any).extract ?? {}) as [string, string][];
  const setExtract = (e: [string, string][]) => onChange({ extract: e.length ? Object.fromEntries(e) : undefined } as any);

  return (
    <div className="section">
      <div className="section-head">
        <h4>Stage: {stage.name ?? stage.id}</h4>
        <div className="actions">
          <button className="ghost small" onClick={() => onMove(-1)}>↑</button>
          <button className="ghost small" onClick={() => onMove(1)}>↓</button>
          <button className="ghost small danger" onClick={onDelete}>Delete</button>
        </div>
      </div>
      <div className="grid2">
        <label>Id<input value={idDraft} onChange={(e) => setIdDraft(e.target.value)} onBlur={() => idDraft !== stage.id && onRename(idDraft)} /></label>
        <label>Name<input value={stage.name ?? ""} onChange={(e) => onChange({ name: e.target.value })} /></label>
        <label>Max runs (loop limit)<input type="number" min={0} value={stage.maxRuns ?? ""} onChange={(e) => onChange({ maxRuns: e.target.value ? Number(e.target.value) : undefined })} /></label>
        <label>Timeout (minutes)<input type="number" min={0} value={stage.timeoutMinutes ?? ""} onChange={(e) => onChange({ timeoutMinutes: e.target.value ? Number(e.target.value) : undefined })} /></label>
        <label>Retries when it fails<input type="number" min={0} value={stage.retries ?? ""} onChange={(e) => onChange({ retries: e.target.value ? Number(e.target.value) : undefined })} /></label>
      </div>

      {stage.type === "agent" && (
        <>
          <div className="grid2">
            <label>Harness
              <select value={stage.harness} onChange={(e) => onChange({ harness: e.target.value } as any)}>
                {Object.entries(harnesses).map(([k, h]) => <option key={k} value={k}>{h.label ?? k}</option>)}
              </select>
            </label>
            <label className="check inline"><input type="checkbox" checked={!!stage.continueSession} onChange={(e) => onChange({ continueSession: e.target.checked } as any)} /> Continue an earlier session of this harness</label>
            <label>Continue only from these stages (ids, comma separated; empty = any)<input value={(stage.continueFrom ?? []).join(", ")} disabled={!stage.continueSession} onChange={(e) => onChange({ continueFrom: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) } as any)} /></label>
            <label className="check inline"><input type="checkbox" checked={!!stage.requirePr} onChange={(e) => onChange({ requirePr: e.target.checked } as any)} /> Fail when there is no PR after this stage</label>
          </div>
          <div className="grid2">
            <label className="check inline"><input type="checkbox" checked={stage.writeHandoff !== false} onChange={(e) => onChange({ writeHandoff: e.target.checked } as any)} /> Write a handoff note for the next agent</label>
            <label className="check inline"><input type="checkbox" checked={stage.allowQuestions !== false} onChange={(e) => onChange({ allowQuestions: e.target.checked } as any)} /> May stop and ask you questions (not in hands-off mode)</label>
            <label className="check inline"><input type="checkbox" checked={stage.readHandoff !== false} onChange={(e) => onChange({ readHandoff: e.target.checked } as any)} /> Receive notes from earlier agents</label>
          </div>
          <label>Prompt<textarea rows={12} value={stage.prompt} onChange={(e) => onChange({ prompt: e.target.value } as any)} spellCheck={false} /></label>
          <p className="hint">Variables: {VARS.map((v) => <code key={v}>{`{{${v}}}`}</code>)}</p>
          <div className="sub">
            <div className="sub-head">Extract variables from the output (regex, first group)
              <button className="ghost small" onClick={() => setExtract([...extract, ["name", "NAME:\\s*(\\S+)"]])}>+ add</button></div>
            {extract.map(([k, re], i) => (
              <div className="row" key={i}>
                <input value={k} onChange={(e) => setExtract(extract.map((x, j) => (j === i ? [e.target.value, x[1]] : x)))} />
                <input className="grow" value={re} onChange={(e) => setExtract(extract.map((x, j) => (j === i ? [x[0], e.target.value] : x)))} />
                <button className="ghost small" onClick={() => setExtract(extract.filter((_, j) => j !== i))}>✕</button>
              </div>
            ))}
          </div>
        </>
      )}
      {stage.type === "shell" && (
        <label>Command (bash, runs in the worktree)<input value={stage.command} onChange={(e) => onChange({ command: e.target.value } as any)} /></label>
      )}
      {stage.type === "approval" && (
        <>
          <label>Message<input value={stage.message ?? ""} onChange={(e) => onChange({ message: e.target.value } as any)} /></label>
          <label>"Send back with notes" goes to
            <select value={stage.sendBackTo ?? ""} onChange={(e) => onChange({ sendBackTo: e.target.value || undefined } as any)}>
              <option value="">(nearest agent stage above)</option>
              {ids.filter((id) => id !== stage.id).map((id) => <option key={id} value={id}>{id}</option>)}
            </select>
          </label>
          <p className="hint">The run waits here for you. In hands-off mode it passes on its own.</p>
        </>
      )}

      <div className="sub">
        <div className="sub-head">Next stage rules (first match wins; no rules = the stage below)
          <button className="ghost small" onClick={() => setNext([...next, { when: "score >= 8", goto: ids[0] }])}>+ rule</button></div>
        {next.map((t, i) => (
          <div className="row" key={i}>
            <span className="muted">if</span>
            <input className="grow" placeholder="(always)" value={t.when ?? ""} onChange={(e) => setNext(next.map((x, j) => (j === i ? { ...x, when: e.target.value || undefined } : x)))} />
            <span className="muted">go to</span>
            <select value={t.goto} onChange={(e) => setNext(next.map((x, j) => (j === i ? { ...x, goto: e.target.value } : x)))}>
              {[...ids, "end"].map((id) => <option key={id} value={id}>{id}</option>)}
            </select>
            <button className="ghost small" onClick={() => setNext(next.filter((_, j) => j !== i))}>✕</button>
          </div>
        ))}
      </div>
    </div>
  );
}

function HarnessesForm({ harnesses, onChange }: { harnesses: Record<string, HarnessConfig>; onChange: (h: Record<string, HarnessConfig>) => void }) {
  const set = (k: string, p: Partial<HarnessConfig>) => onChange({ ...harnesses, [k]: { ...harnesses[k], ...p } });
  const lines = (a?: string[]) => (a ?? []).join("\n");
  const parse = (s: string) => s.split("\n").filter((x) => x !== "");
  return (
    <div className="section">
      <div className="section-head">
        <h4>Harnesses</h4>
        <button className="ghost small" onClick={() => { const k = prompt("Harness id (e.g. gemini)"); if (k) onChange({ ...harnesses, [k]: { label: k, command: k, args: ["-p", "{{prompt}}"] } }); }}>+ harness</button>
      </div>
      <p className="hint">One argument per line. <code>{"{{prompt}}"}</code> is the full prompt as one argument. <code>{"{{outputFile}}"}</code> is a temp file; if the agent writes its final answer there, that is used as the stage output.</p>
      {Object.entries(harnesses).map(([k, h]) => (
        <details key={k} className="harness">
          <summary><b>{h.label ?? k}</b> <code>{h.command} {h.args.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ")}</code></summary>
          <div className="grid2">
            <label>Label<input value={h.label ?? ""} onChange={(e) => set(k, { label: e.target.value })} /></label>
            <label>Command<input value={h.command} onChange={(e) => set(k, { command: e.target.value })} /></label>
            <label>Args<textarea rows={6} value={lines(h.args)} onChange={(e) => set(k, { args: parse(e.target.value) })} spellCheck={false} /></label>
            <label>Args to continue one exact session (uses {"{{sessionId}}"})<textarea rows={6} value={lines(h.resumeArgs)} onChange={(e) => set(k, { resumeArgs: e.target.value ? parse(e.target.value) : undefined })} spellCheck={false} /></label>
            <label>Regex that finds the session id in the output<input value={h.sessionIdPattern ?? ""} onChange={(e) => set(k, { sessionIdPattern: e.target.value || undefined })} spellCheck={false} /></label>
            <label>Fallback: args to continue the most recent session<textarea rows={4} value={lines(h.continueArgs)} onChange={(e) => set(k, { continueArgs: e.target.value ? parse(e.target.value) : undefined })} spellCheck={false} /></label>
            <label>Output format
              <select value={h.format ?? "text"} onChange={(e) => set(k, { format: e.target.value as any })}>
                <option value="text">text</option>
                <option value="claude-stream-json">claude-stream-json</option>
              </select>
            </label>
            <div className="row end"><button className="ghost small danger" onClick={() => { const n = { ...harnesses }; delete n[k]; onChange(n); }}>Remove harness</button></div>
          </div>
        </details>
      ))}
    </div>
  );
}
