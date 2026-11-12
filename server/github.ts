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
    const issues: Issue[] = JSON.parse(out).map((i: any) => ({ number: i.number, title: i.title, body: i.body, url: i.url, labels: i.labels?.map((l: any) => l.name) ?? [] }));
    // ponytail: one `gh api` call per issue, 10 at a time. Use one GraphQL query if big repos make this slow.
    const result: Issue[] = [];
    for (let k = 0; k < issues.length; k += 10) result.push(...(await Promise.all(issues.slice(k, k + 10).map((i) => withNativeBlockers(i, this.dependencies)))));
    return result;
  }

  async getIssue(n: number): Promise<Issue> {
    const out = await exec("gh", ["issue", "view", String(n), "--json", "number,title,body,url"], this.repo);
    return withNativeBlockers(JSON.parse(out), this.dependencies);
  }

  /** Raw JSON of an issue's native "blocked by" links. gh fills in {owner} and {repo}. */
  private dependencies = (n: number) => exec("gh", ["api", `repos/{owner}/{repo}/issues/${n}/dependencies/blocked_by?per_page=100`], this.repo);

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

/**
 * Issue numbers from the JSON of GitHub's issue dependencies endpoint (`.../dependencies/blocked_by`):
 * a list of issues. Blockers in another repo are skipped, because their number means nothing in this one.
 */
export function parseDependencies(json: unknown, issue: Pick<Issue, "number" | "url">): number[] {
  if (!Array.isArray(json)) return [];
  const repoOf = (url?: string) => url?.replace(/\/issues\/\d+$/, "");
  const own = repoOf(issue.url);
  const nums = json
    .filter((d) => Number.isInteger(d?.number) && (!own || !d.html_url || repoOf(d.html_url) === own))
    .map((d) => d.number as number)
    .filter((n) => n !== issue.number);
  return [...new Set(nums)];
}

/**
 * The issue with `blockedBy` set to its native "blocked by" links plus its "Blocked by" text.
 * If the dependencies call fails, the text blockers are still used.
 */
export async function withNativeBlockers(issue: Issue, fetchDependencies: (n: number) => Promise<string>): Promise<Issue> {
  let native: number[] = [];
  try { native = parseDependencies(JSON.parse(await fetchDependencies(issue.number)), issue); } catch {}
  return { ...issue, blockedBy: [...new Set([...native, ...parseBlockers(issue.body, issue.number)])] };
}
