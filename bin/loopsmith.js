#!/usr/bin/env node
// Usage: loopsmith [--repo <path>] [--port 4317] [--demo]
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsx = path.join(root, "node_modules", ".bin", "tsx");
const args = process.argv.slice(2);
if (!args.includes("--repo") && !args.includes("--demo")) args.push("--repo", process.cwd());

function run(command, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    // Pass stop signals on, or the server outlives this launcher (e.g. a terminal that only kills its own child).
    const forward = (sig) => child.kill(sig);
    for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, forward);
    child.on("error", (error) => { console.error(error.message); resolve(1); });
    child.on("exit", (code) => {
      for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.off(sig, forward);
      resolve(code ?? 1);
    });
  });
}

// Rebuild before starting the API so the UI and its log protocol stay in sync.
const built = await run(process.execPath, [path.join(root, "node_modules/vite/bin/vite.js"), "build"], root);
if (built !== 0) process.exit(built);
process.exitCode = await run(tsx, [path.join(root, "server/index.ts"), ...args]);
