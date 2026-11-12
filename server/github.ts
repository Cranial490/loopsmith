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
}

/** Talks to GitHub through the `gh` CLI, so it uses your existing gh login. */
export class GhCli implements GitHost {
  constructor(private repo: string) {}

  async listIssues(): Promise<Issue[]> {
    const out = await exec("gh", ["issue", "list", "--state", "open", "--limit", "200", "--json", "number,title,body,url,labels"], this.repo);
    return this.withBlockers(JSON.parse(out).map(fromGh));
  }

  async listSpecs(): Promise<Issue[]> {
    const out = await exec("gh", ["issue", "list", "--state", "open", "--label", SPEC_LABEL, "--limit", "200", "--json", "number,title,body,url,labels"], this.repo);
    return JSON.parse(out).map(fromGh);
  }

  async listTickets(spec: number): Promise<Issue[]> {
    // Every issue in the repo (pull requests left out), so old text-parent tickets are found too.
    // ponytail: pages through all issues on each call. Use a search query if a repo gets very big.
    const ndjson = (jq: string, path: string) => exec("gh", ["api", "--paginate", path, "--jq", jq], this.repo);
    const [subs, all] = await Promise.all([
      ndjson(".[]", `repos/{owner}/{repo}/issues/${spec}/sub_issues?per_page=100`),
      ndjson(".[] | select(.pull_request | not)", "repos/{owner}/{repo}/issues?state=all&per_page=100"),
    ]);
    return this.withBlockers(ticketsFromRest(spec, parseLines(subs), parseLines(all)));
  }

  private async withBlockers(issues: Issue[]): Promise<Issue[]> {
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

export const SPEC_LABEL = "spec";

/** An issue as `gh issue list --json ...` prints it. */
const fromGh = (i: any): Issue => ({ number: i.number, title: i.title, body: i.body, url: i.url, labels: i.labels?.map((l: any) => l.name) ?? [], ...(i.state ? { state: i.state.toLowerCase() } : {}) });

/** An issue as the REST API returns it. */
const fromRest = (i: any): Issue => fromGh({ ...i, url: i.html_url });

/** One JSON value per line, as `gh api --jq` prints them. */
const parseLines = (out: string) => out.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));

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
