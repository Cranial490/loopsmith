import { exec } from "./proc.js";

export interface Issue { number: number; title: string; body?: string; url?: string; labels?: string[]; blockedBy?: number[] }
export interface PullRequest { number: number; url: string; state?: string }

export interface GitHost {
  listIssues(): Promise<Issue[]>;
  getIssue(n: number): Promise<Issue>;
  findPr(branch: string): Promise<PullRequest | undefined>;
}

/** Talks to GitHub through the `gh` CLI, so it uses your existing gh login. */
export class GhCli implements GitHost {
  constructor(private repo: string) {}

  async listIssues(): Promise<Issue[]> {
    const out = await exec("gh", ["issue", "list", "--state", "open", "--limit", "200", "--json", "number,title,body,url,labels"], this.repo);
    return JSON.parse(out).map((i: any) => ({ number: i.number, title: i.title, body: i.body, url: i.url, labels: i.labels?.map((l: any) => l.name) ?? [], blockedBy: parseBlockers(i.body, i.number) }));
  }

  async getIssue(n: number): Promise<Issue> {
    const out = await exec("gh", ["issue", "view", String(n), "--json", "number,title,body,url"], this.repo);
    const i = JSON.parse(out);
    return { ...i, blockedBy: parseBlockers(i.body, i.number) };
  }

  async findPr(branch: string): Promise<PullRequest | undefined> {
    const out = await exec("gh", ["pr", "list", "--head", branch, "--state", "all", "--limit", "1", "--json", "number,url,state"], this.repo);
    return JSON.parse(out)[0];
  }
}

/**
 * Issue numbers after a "Blocked by" line or heading (the format /to-issues writes).
 * Reads until the next markdown heading.
 */
export function parseBlockers(body: string | undefined, self?: number): number[] {
  const m = body?.match(/blocked by/i);
  if (!m || !body) return [];
  let rest = body.slice(m.index! + m[0].length, m.index! + 800);
  const nextHeading = rest.search(/\n#{1,6}\s/);
  if (nextHeading >= 0) rest = rest.slice(0, nextHeading);
  const nums = [...rest.matchAll(/#(\d+)/g)].map((x) => Number(x[1])).filter((n) => n !== self);
  return [...new Set(nums)];
}
