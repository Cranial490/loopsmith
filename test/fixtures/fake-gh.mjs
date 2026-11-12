#!/usr/bin/env node
// A stand-in for `gh` in a big repo: 350 issues with 70 KB bodies (about 24 MB in all) and 250 open specs.
// Spec #10 has sub-issue #300 and a text-parent ticket #5. A pull request also says "Part of #10".
const args = process.argv.slice(2);
const path = args.find((a) => a.startsWith("repos/")) ?? "";
const page = Number(path.match(/[?&]page=(\d+)/)?.[1] ?? 0);
const issue = (number, extra = {}) => ({ number, title: `t${number}`, state: "open", html_url: `https://github.com/o/r/issues/${number}`, labels: [], body: "x".repeat(70000), ...extra });
const all = Array.from({ length: 350 }, (_, k) => {
  const n = 350 - k;
  if (n === 5) return issue(n, { body: "Part of #10\n" + "x".repeat(70000) });
  if (n === 6) return issue(n, { body: "Part of #10", pull_request: {} });
  return issue(n);
});
const specs = Array.from({ length: 250 }, (_, k) => issue(1000 + k, { labels: [{ name: "spec" }], body: "spec" }));
const paged = (list) => (page ? list.slice((page - 1) * 100, page * 100) : list);
let out;
if (/\/dependencies\/blocked_by/.test(path)) out = [];
else if (/issues\/10\/sub_issues/.test(path)) out = paged([issue(300)]);
else if (/issues\?.*labels=spec/.test(path)) out = paged(specs);
else if (/issues\?.*state=all/.test(path)) out = paged(all);
else if (args[0] === "issue" && args[1] === "view") out = issue(Number(args[2]));
else { process.stderr.write(`fake gh: unknown call ${args.join(" ")}\n`); process.exit(1); }
// `--paginate --jq '.[]'` prints one item per line.
process.stdout.write(Array.isArray(out) && args.includes("--jq") ? out.map((x) => JSON.stringify(x)).join("\n") : JSON.stringify(out));
