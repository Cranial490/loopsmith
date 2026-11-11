import { spawn, execFile } from "node:child_process";

export interface ProcResult { code: number | null; stdout: string; killed: boolean }

export interface RunningProc {
  done: Promise<ProcResult>;
  kill(): void;
}

/**
 * Start a process in its own process group so that "stop" also kills
 * the children the agent starts (test runners, dev servers, ...).
 */
export function startProc(opts: {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  onStdout: (chunk: string) => void;
  onStderr: (chunk: string) => void;
}): RunningProc {
  const child = spawn(opts.command, opts.args, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let killed = false;
  const kill = () => {
    killed = true;
    const pid = child.pid;
    if (!pid) return;
    try { process.kill(-pid, "SIGTERM"); } catch {}
    setTimeout(() => { try { process.kill(-pid, "SIGKILL"); } catch {} }, 5000).unref();
  };
  const timer = opts.timeoutMs ? setTimeout(kill, opts.timeoutMs) : undefined;
  child.stdout.setEncoding("utf8").on("data", (c: string) => { stdout += c; if (stdout.length > 2_000_000) stdout = stdout.slice(-1_000_000); opts.onStdout(c); });
  child.stderr.setEncoding("utf8").on("data", (c: string) => opts.onStderr(c));
  const done = new Promise<ProcResult>((resolve) => {
    // A command that is not installed gives "error" and sometimes no "close".
    child.on("error", (err: Error) => {
      opts.onStderr(`\n[loopsmith] failed to start "${opts.command}": ${err.message}. Is it installed and on your PATH?\n`);
      if (timer) clearTimeout(timer);
      resolve({ code: 127, stdout, killed });
    });
    child.on("close", (code: number | null) => { if (timer) clearTimeout(timer); resolve({ code, stdout, killed }); });
  });
  return { done, kill };
}

/** Run a short command and return stdout. Rejects on non-zero exit. */
export function exec(command: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd, maxBuffer: 20 * 1024 * 1024 }, (err: Error | null, stdout: string, stderr: string) => {
      if (err) reject(new Error(`${command} ${args.join(" ")} failed: ${stderr || err.message}`));
      else resolve(stdout);
    });
  });
}
