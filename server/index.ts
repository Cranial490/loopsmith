import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { loadConfig, saveConfig, validateConfig, defaultConfig, type Config } from "./config.js";
import { Engine } from "./engine.js";
import { GhCli, type GitHost } from "./github.js";
import { setupDemoRepo, DemoHost } from "./demo.js";
import { listModels } from "./models.js";

const argv = process.argv.slice(2);
const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const demo = argv.includes("--demo");
const port = Number(flag("--port") ?? process.env.PORT ?? 4317);
const repo = demo ? setupDemoRepo() : path.resolve(flag("--repo") ?? process.cwd());

if (!fs.existsSync(path.join(repo, ".git"))) {
  console.error(`${repo} is not a git repository. Use --repo <path> or --demo.`);
  process.exit(1);
}

let config: Config = loadConfig(repo);
const host: GitHost = demo ? new DemoHost() : new GhCli(repo);
const engine = new Engine(repo, () => config, host);

const app = express();
// Only this computer may use the API. This stops a web page you visit from
// calling loopsmith (which can run shell commands) through your browser.
const LOCAL = ["localhost", "127.0.0.1", "[::1]", "::1"];
app.use((req, res, next) => {
  const host = (req.headers.host ?? "").replace(/:\d+$/, "");
  let originOk = true;
  if (req.headers.origin) { try { originOk = LOCAL.includes(new URL(req.headers.origin).hostname); } catch { originOk = false; } }
  if (!LOCAL.includes(host) || !originOk) { res.status(403).send("loopsmith only accepts requests from this computer"); return; }
  next();
});
app.use(express.json({ limit: "2mb" }));

const wrap = (fn: (req: express.Request, res: express.Response) => any) => async (req: express.Request, res: express.Response) => {
  try { const out = await fn(req, res); if (!res.headersSent) res.json(out ?? { ok: true }); }
  catch (e: any) { res.status(400).json({ error: e.message ?? String(e) }); }
};

app.get("/api/state", wrap(() => ({ repo, demo, config, runs: [...engine.runs.values()] })));
app.post("/api/runs/:id/answer", wrap((req) => engine.answer(String(req.params.id), String(req.body?.text ?? ""))));
app.post("/api/runs/:id/send-back", wrap((req) => engine.sendBack(String(req.params.id), String(req.body?.notes ?? ""))));
app.get("/api/issues", wrap(() => host.listIssues()));
app.get("/api/specs", wrap(() => host.listSpecs().catch((e) => { throw new Error(`Could not load specs from GitHub: ${e?.message ?? e}`); })));
app.get("/api/specs/:n", wrap((req) => engine.specGraph(Number(req.params.n))));
app.post("/api/runs", wrap((req) => engine.enqueue(req.body.issues ?? [], { autoApprove: !!req.body.autoApprove })));
app.post("/api/runs/:id/approve", wrap((req) => engine.approve(String(req.params.id))));
app.post("/api/runs/:id/reject", wrap((req) => engine.reject(String(req.params.id))));
app.post("/api/runs/:id/stop", wrap((req) => engine.stop(String(req.params.id))));
app.post("/api/runs/:id/resume", wrap((req) => engine.resume(String(req.params.id), { resetLimits: !!req.body?.resetLimits, fromStage: req.body?.fromStage || undefined })));
app.delete("/api/runs/:id", wrap((req) => engine.remove(String(req.params.id))));
app.get("/api/runs/:id/steps/:index/log", (req, res) => {
  res.json(engine.readLog(String(req.params.id), Number(req.params.index)));
});
app.put("/api/config", wrap((req) => {
  const next = req.body as Config;
  const errors = validateConfig(next);
  if (errors.length) throw new Error(errors.join("\n"));
  config = next;
  saveConfig(repo, config);
  broadcast("config", config);
  return config;
}));
app.get("/api/models", wrap(() => listModels(config.harnesses)));
app.get("/api/config/default", wrap(() => defaultConfig()));

// Server-sent events: live run updates and log lines.
const clients = new Set<express.Response>();
function broadcast(type: string, data: unknown) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) c.write(msg);
}
app.get("/api/events", (req, res) => {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.write("retry: 2000\n\n");
  clients.add(res);
  req.on("close", () => clients.delete(res));
});
setInterval(() => { for (const c of clients) c.write(": ping\n\n"); }, 20_000).unref();
engine.on("run", (run) => broadcast("run", run));
engine.on("log", (l) => broadcast("log", l));
engine.on("removed", (id) => broadcast("removed", { id }));

const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../web/dist");
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get("*", (_req, res) => res.sendFile(path.join(webDist, "index.html")));
}

// Stop the agents when loopsmith stops. They run in their own process groups,
// so without this they would keep working with nobody watching.
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(sig, () => { engine.shutdown(); process.exit(0); });
}

app.listen(port, "127.0.0.1", () => {
  console.log(`loopsmith ${demo ? "(demo) " : ""}for ${repo}`);
  console.log(`→ http://localhost:${port}`);
});
