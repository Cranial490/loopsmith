import { exec } from "./proc.js";

export interface Issue { number: number; title: string; body?: string; url?: string; labels?: string[]; blockedBy?: number[]; state?: "open" | "closed" }
export interface PullRequest { number: number; url: string; state?: string }

export interface GitHost {
  listIssues(): Promise<Issue[]>;
  getIssue(n: number): Promise<Issue>;
  /** Open issues labelled `spec`. */
  listSpecs(): Promise<Issue[]>;
  /** The tickets of spec `spec`, open and closed, with `state` and `blockedBy` set. */
  listTickets(spec: number): Promise<Issue[]>;
  findPr(branch: string): Promise<PullRequest | undefined>;
  createPr(pr: { head: string; base: string; title: string; body: string }): Promise<PullRequest>;
}

/** Talks to GitHub through the `gh` CLI, so it uses your existing gh login. */
export class GhCli implements GitHost {
  constructor(private repo: string) {}

  async listIssues(): Promise<Issue[]> {
    const out = await exec("gh", ["issue", "list", "--state", "open", "--limit", "200", "--json", "number,title,body,url,labels"], this.repo);
    return this.withBlockers(JSON.parse(out).map(fromGh));
  }

  async listSpecs(): Promise<Issue[]> {
    const specs: Issue[] = [];
    for await (const page of this.pages(`repos/{owner}/{repo}/issues?state=open&labels=${SPEC_LABEL}`)) specs.push(...page.filter((i) => !i.pull_request).map(fromRest));
    return specs;
  }

  async listTickets(spec: number): Promise<Issue[]> {
    const subs: any[] = [];
    for await (const page of this.pages(`repos/{owner}/{repo}/issues/${spec}/sub_issues`)) subs.push(...page);
    const subNums = new Set(subs.map((s) => s?.number));
    // Every issue in the repo, so old text-parent tickets are found too. One page at a time,
    // keeping only the spec and its tickets, so a big repo never builds one huge result.
    // ponytail: reads all issues on each call. Use a search query if this gets slow.
    const kept: any[] = [];
    for await (const page of this.pages("repos/{owner}/{repo}/issues?state=all")) {
      kept.push(...page.filter((i) => !i.pull_request && (i.number === spec || subNums.has(i.number) || parseParent(i.body) === spec)));
    }
    return this.withBlockers(ticketsFromRest(spec, subs, kept));
  }

  /** A REST list endpoint, 100 items per call, until a short page. */
  private async *pages(path: string): AsyncGenerator<any[]> {
    for (let page = 1; ; page++) {
      const items = JSON.parse(await exec("gh", ["api", `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`], this.repo));
      if (!Array.isArray(items)) throw new Error(`Unexpected reply from GitHub for ${path}`);
      yield items;
      if (items.length < 100) return;
    }
  }

  private async withBlockers(issues: Issue[]): Promise<Issue[]> {
    // ponytail: one `gh api` call per issue, 10 at a time. Use one GraphQL query if big repos make this slow.
    const result: Issue[] = [];
    for (let k = 0; k < issues.length; k += 10) result.push(...(await Promise.all(issues.slice(k, k + 10).map((i) => withNativeBlockers(i, this.dependencies)))));
    return result;
  }

  async getIssue(n: number): Promise<Issue> {
    const out = await exec("gh", ["issue", "view", String(n), "--json", "number,title,body,url,state"], this.repo);
    const issue = JSON.parse(out);
    return withNativeBlockers({ ...issue, state: issue.state?.toLowerCase() }, this.dependencies);
  }

  /** Raw JSON of an issue's native "blocked by" links. gh fills in {owner} and {repo}. */
  private dependencies = (n: number) => exec("gh", ["api", `repos/{owner}/{repo}/issues/${n}/dependencies/blocked_by?per_page=100`], this.repo);

  async findPr(branch: string): Promise<PullRequest | undefined> {
    const out = await exec("gh", ["pr", "list", "--head", branch, "--state", "all", "--limit", "1", "--json", "number,url,state"], this.repo);
    return JSON.parse(out)[0];
  }

  async createPr(pr: { head: string; base: string; title: string; body: string }): Promise<PullRequest> {
    const url = (await exec("gh", ["pr", "create", "--head", pr.head, "--base", pr.base, "--title", pr.title, "--body", pr.body], this.repo)).trim().split("\n").at(-1)!;
    return { number: Number(url.match(/(\d+)$/)?.[1]), url };
  }
}

export const SPEC_LABEL = "spec";

/** An issue as `gh issue list --json ...` prints it. */
const fromGh = (i: any): Issue => ({ number: i.number, title: i.title, body: i.body, url: i.url, labels: i.labels?.map((l: any) => l.name) ?? [], ...(i.state ? { state: i.state.toLowerCase() } : {}) });

/** An issue as the REST API returns it. */
const fromRest = (i: any): Issue => fromGh({ ...i, url: i.html_url });

/**
 * The tickets of a spec from REST issue objects: its sub-issues plus all issues with a parent line for it.
 * A sub-issue missing from `all` is still used, from the sub-issues response itself.
 */
export function ticketsFromRest(spec: number, subIssues: any[], all: any[]): Issue[] {
  const issues = all.map(fromRest);
  const known = new Set(issues.map((i) => i.number));
  const specUrl = issues.find((i) => i.number === spec)?.url;
  const subs = parseSubIssues(subIssues, { number: spec, url: specUrl });
  const own = subIssues.filter((d) => subs.includes(d?.number) && !known.has(d.number)).map(fromRest);
  return ticketsOf(spec, [...issues, ...own], subs);
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
 * Ticket numbers from the JSON of GitHub's sub-issues endpoint (`.../issues/N/sub_issues`).
 * It is a list of issues like the dependencies endpoint, so the same rules apply.
 */
export const parseSubIssues = parseDependencies;

/** The spec number from a `Part of #N` line or a `## Parent` heading followed by `#N`. */
export function parseParent(body: string | undefined): number | undefined {
  const m = body?.match(/^[ \t>*_-]*(?:part of|#{1,6}[ \t]*parent)[\s:*_]*#(\d+)/im);
  return m ? Number(m[1]) : undefined;
}

/** The tickets of a spec: its sub-issues plus issues with a parent line for it. Each once, never the spec itself. */
export function ticketsOf(spec: number, all: Issue[], subIssues: number[]): Issue[] {
  const subs = new Set(subIssues);
  return all.filter((i) => i.number !== spec && (subs.has(i.number) || parseParent(i.body) === spec)).sort((a, b) => a.number - b.number);
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
