import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { spawn, execFileSync } from "node:child_process";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stale = "outdated UI that expects log.text";

async function fixture(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loopsmith-startup-"));
  const app = path.join(dir, "app");
  const repo = path.join(dir, "target");
  fs.mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  for (const file of ["bin", "server", "web/src", "web/index.html", "web/tsconfig.json", "tsconfig.json", "vite.config.ts", "package.json"]) {
    const dest = path.join(app, file);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(path.join(project, file), dest, { recursive: true });
  }
  fs.symlinkSync(path.join(project, "node_modules"), path.join(app, "node_modules"), "dir");
  fs.mkdirSync(path.join(app, "web/dist"), { recursive: true });
  fs.writeFileSync(path.join(app, "web/dist/index.html"), stale);

  const socket = net.createServer();
  await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const port = (socket.address() as net.AddressInfo).port;
  await new Promise<void>((resolve, reject) => socket.close((err) => err ? reject(err) : resolve()));
  const url = `http://127.0.0.1:${port}`;

  const launch = (command: string, args: string[], cwd: string) => {
    let output = "";
    const child = spawn(command, args, { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (c) => { output += c; });
    child.stderr.on("data", (c) => { output += c; });
    const closed = new Promise<number | null>((resolve) => child.on("close", resolve));
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null && child.pid) {
        try { process.kill(-child.pid, "SIGTERM"); } catch {}
      }
      await closed;
      fs.rmSync(dir, { recursive: true, force: true });
    });
    return { child, closed, output: () => output };
  };
  return { app, repo, port, url, launch };
}

test("startup rebuilds stale UI assets from the app directory before serving a different repo", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  const p = f.launch(process.execPath, [path.join(f.app, "bin/loopsmith.js"), "--port", String(f.port)], f.repo);
  let html: string | undefined;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    assert.equal(p.child.exitCode, null, p.output());
    try {
      const response = await fetch(f.url);
      if (response.ok) { html = await response.text(); break; }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(html, `Server did not start: ${p.output()}`);
  assert.ok(!html.includes(stale), "startup must replace the old log.text UI before serving it");
  const asset = html.match(/src="([^"]+\.js)"/)?.[1];
  assert.ok(asset, "the freshly built UI includes its JavaScript bundle");
  assert.equal((await fetch(new URL(asset, f.url))).status, 200);
  const state = await (await fetch(`${f.url}/api/state`)).json();
  assert.equal(fs.realpathSync(state.repo), fs.realpathSync(f.repo), "building must preserve the caller's target repository");
  assert.deepEqual(await (await fetch(`${f.url}/api/runs/missing/steps/0/log`)).json(), []);
});

test("npm start stops on a UI build failure instead of serving stale assets", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.app, "web/src/main.tsx"), "export const broken = ;");
  const p = f.launch("npm", ["start", "--", "--repo", f.repo, "--port", String(f.port)], f.app);
  assert.notEqual(await p.closed, 0, "a failed build must fail startup");
  assert.doesNotMatch(p.output(), /loopsmith for /, "the API must not start after a failed build");
  await assert.rejects(fetch(f.url), "no server should be listening with the old UI");
});
