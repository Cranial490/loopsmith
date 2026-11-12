import fs from "node:fs";
import path from "node:path";
import { exec } from "./proc.js";

async function ok(cmd: string, args: string[], cwd: string) {
  try { await exec(cmd, args, cwd); return true; } catch { return false; }
}

/**
 * Make (or reuse) a worktree for one issue. New branches start from the
 * freshest base branch, so issue N+1 sees the merged work of issue N.
 */
export async function ensureWorktree(repo: string, dir: string, branch: string, baseBranch: string, log: (s: string) => void) {
  if (fs.existsSync(path.join(dir, ".git"))) {
    log(`Reusing worktree ${dir}\n`);
    return;
  }
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  await ok("git", ["worktree", "prune"], repo); // forget worktrees whose folder was deleted by hand
  const hasOrigin = await ok("git", ["remote", "get-url", "origin"], repo);
  if (hasOrigin) {
    log(`git fetch origin ${baseBranch}\n`);
    await exec("git", ["fetch", "origin", baseBranch], repo);
  }
  const branchExists = await ok("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], repo);
  if (branchExists) {
    log(`git worktree add ${dir} ${branch}\n`);
    await exec("git", ["worktree", "add", dir, branch], repo);
  } else {
    const base = hasOrigin ? `origin/${baseBranch}` : baseBranch;
    log(`git worktree add -b ${branch} ${dir} ${base}\n`);
    await exec("git", ["worktree", "add", "-b", branch, dir, base], repo);
  }
}

/** Make `branch` from `from` when it does not exist yet: on origin when there is one, else locally. */
export async function ensureBranch(repo: string, branch: string, from: string) {
  if (await ok("git", ["remote", "get-url", "origin"], repo)) {
    if (await ok("git", ["ls-remote", "--exit-code", "--heads", "origin", branch], repo)) return;
    await exec("git", ["fetch", "origin", from], repo);
    await exec("git", ["push", "origin", `refs/remotes/origin/${from}:refs/heads/${branch}`], repo);
  } else if (!(await ok("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], repo))) {
    await exec("git", ["branch", branch, from], repo);
  }
}

export async function removeWorktree(repo: string, dir: string) {
  if (fs.existsSync(dir)) await ok("git", ["worktree", "remove", "--force", dir], repo);
}

export async function deleteBranch(repo: string, branch: string) {
  await ok("git", ["branch", "-D", branch], repo);
}
