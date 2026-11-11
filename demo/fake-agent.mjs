#!/usr/bin/env node
// A fake agent for demo mode. It prints lines slowly, like a real agent,
// and the review stage gives scores 5 -> 7 -> 9 so you can watch the loop.
import fs from "node:fs";

const stage = process.env.LOOPSMITH_STAGE ?? "agent";
const issue = process.env.LOOPSMITH_ISSUE ?? "?";
const prompt = process.argv.at(-1) ?? "";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = async (s, ms = 450) => { process.stdout.write(s + "\n"); await sleep(ms); };

const ri = process.argv.indexOf("--resume");
const sid = ri > 0 ? process.argv[ri + 1] : `fake-${Math.random().toString(16).slice(2, 10)}`;
await say(`session id: ${sid}${ri > 0 ? " (resumed)" : ""}`, 50);
await say(`[fake-agent] stage=${stage} issue=#${issue}`);
await say(`[fake-agent] prompt starts with: ${prompt.split("\n")[0].slice(0, 90)}`);

const qf = process.env.LOOPSMITH_QUESTION_FILE;
if (stage === "implement" && process.env.FAKE_ASK && qf && !fs.existsSync(".fake-asked")) {
  await say("→ Read README.md");
  await say("I need a decision before I continue.");
  fs.writeFileSync(".fake-asked", "1");
  fs.writeFileSync(qf, "1. Where must orders be stored?\n   Options: (a) SQLite file, (b) Postgres. I recommend (a): no new service.\n2. Must an order have a customer email? I recommend: yes, required.\n");
  process.exit(0);
}
if (stage === "implement") {
  if (prompt.includes("The human answered your questions")) await say("Thanks. I continue with your answers.");
  await say("→ Read README.md");
  await say("→ Write test: src/feature.test.ts (red)");
  await say("→ Bash npm test   ✗ 1 failing");
  await say("→ Edit src/feature.ts");
  await say("→ Bash npm test   ✓ 12 passing");
  fs.writeFileSync(`feature-${issue}.txt`, "done\n");
  await say("→ Bash git commit -am 'feat: issue' && git push && gh pr create");
  await say(`Opened PR #${100 + Number(issue)}. Summary: added the feature with tests.`);
} else if (stage === "review") {
  const f = ".fake-reviews";
  const n = fs.existsSync(f) ? Number(fs.readFileSync(f, "utf8")) : 0;
  fs.writeFileSync(f, String(n + 1));
  const score = [5, 7, 9][Math.min(n, 2)];
  await say("Reading the diff…", 600);
  if (score < 8) {
    await say("1. MAJOR: The input is not validated. Fix: check for empty input. Reason: it crashes.");
    await say("2. MINOR: The function name is not clear. Fix: rename to parseOrder. Reason: easier to read.");
  } else {
    await say("1. MINOR: One comment has a typo.");
  }
  await say(`SCORE: ${score}/10`);
} else if (stage === "fix") {
  await say("→ Edit src/feature.ts (add input check)");
  await say("→ Bash npm test   ✓ 13 passing");
  await say("→ Bash git commit -am 'fix: review' && git push");
  await say("Fixed the major issues.");
} else {
  await say("Done.");
}

const hf = process.env.LOOPSMITH_HANDOFF_FILE;
if (hf) {
  const got = prompt.includes("## Handoff notes from earlier agents") ? "yes" : "no";
  const notes = {
    implement: "## What I did\nAdded the feature with tests (TDD).\n## Decisions and why\nKept one module, no new dependency.\n## Not done / open problems\nInput validation is basic.\n## Instructions for the next agent\nTests: npm test. Main file: src/feature.ts.",
    review: "## What I did\nReviewed the PR diff.\n## Not done / open problems\nSee the issues in my review output.\n## Instructions for the next agent\nFix MAJOR items first.",
    fix: "## What I did\nAdded the input check from the review.\n## Instructions for the next agent\nRe-check validation in src/feature.ts.",
  };
  fs.writeFileSync(hf, (notes[stage] ?? "## What I did\nMy part.") + `\n\n(received earlier notes: ${got})\n`);
  await say(`[fake-agent] wrote handoff note (received earlier notes: ${got})`, 100);
}
