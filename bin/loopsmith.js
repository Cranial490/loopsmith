#!/usr/bin/env node
// Usage: loopsmith [--repo <path>] [--port 4317] [--demo]
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsx = path.join(root, "node_modules", ".bin", "tsx");
const args = process.argv.slice(2);
if (!args.includes("--repo") && !args.includes("--demo")) args.push("--repo", process.cwd());
spawn(tsx, [path.join(root, "server/index.ts"), ...args], { stdio: "inherit" }).on("exit", (c) => process.exit(c ?? 0));
