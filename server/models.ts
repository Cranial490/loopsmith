import { execFile } from "node:child_process";
import type { HarnessConfig } from "./config.js";

// Used when the live list can't be read (Claude Code has no command that lists models).
const CLAUDE_FALLBACK = [
  "claude-fable-5-2", "claude-fable-5-1", "claude-fable-5", "claude-opus-5-5", "claude-opus-5", "claude-opus-4-8",
  "claude-sonnet-5-5", "claude-sonnet-5", "claude-haiku-5-5", "claude-haiku-4-5",
];

/** Model ids from `codex debug models` output. */
export function parseCodexModels(json: string): string[] {
  const d = JSON.parse(json);
  const list: any[] = Array.isArray(d) ? d : d.models ?? [];
  return list.map((m) => m.slug).filter((s): s is string => typeof s === "string");
}

function codexModels(command: string): Promise<string[]> {
  return new Promise((resolve) => {
    execFile(command, ["debug", "models"], { timeout: 15_000, maxBuffer: 16 << 20 }, (err, out) => {
      try { resolve(err ? [] : parseCodexModels(out)); } catch { resolve([]); }
    });
  });
}

/** Anthropic's model list; needs ANTHROPIC_API_KEY (the Claude CLI's own sign-in can't be used). */
async function claudeModels(): Promise<string[]> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return CLAUDE_FALLBACK;
  try {
    const r = await fetch("https://api.anthropic.com/v1/models?limit=1000", { headers: { "x-api-key": key, "anthropic-version": "2023-06-01" } });
    const ids = ((await r.json()).data ?? []).map((m: any) => m.id).filter(Boolean);
    return ids.length ? ids : CLAUDE_FALLBACK;
  } catch { return CLAUDE_FALLBACK; }
}

// ponytail: read once per server start; restart Loopsmith to pick up new models.
const cache = new Map<string, Promise<string[]>>();

/** Model ids for each harness whose CLI we know how to ask. Others get no suggestions. */
export async function listModels(harnesses: Record<string, HarnessConfig>): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const [id, h] of Object.entries(harnesses)) {
    const cli = h.command.split("/").pop();
    const load = cli === "codex" ? () => codexModels(h.command) : cli === "claude" ? claudeModels : undefined;
    if (!load) continue;
    if (!cache.has(h.command)) cache.set(h.command, load());
    out[id] = await cache.get(h.command)!;
  }
  return out;
}
