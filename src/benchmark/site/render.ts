/**
 * Benchmark site (workstream 3, track G): page templates. Pure functions from their inputs to
 * HTML strings, no I/O, so a build is deterministic (no clock, no host, no environment).
 *
 * The results page renders numbers from `VerifiedResult`s only (`assertVerified`): with none it
 * renders the labelled placeholder ("no verified results yet") and no number at all. A
 * test-fixture result renders under a TEST FIXTURE banner on every row it fills.
 */
import { COST_BASIS, type Rate } from "../check.ts";
import type { BenchmarkTask } from "../task-types.ts";
import { escapeHtml as e } from "./markdown.ts";
import { assertVerified, type VerifiedResult } from "./results.ts";

export const PLACEHOLDER = "No verified results yet";
export const FIXTURE_BANNER = "TEST FIXTURE: not a benchmark result";

export const PAGES = [
  { file: "index.html", title: "Overview" },
  { file: "task-set.html", title: "Task set" },
  { file: "protocol.html", title: "Grading protocol" },
  { file: "grader.html", title: "Grader" },
  { file: "results.html", title: "Results" },
] as const;
export type PageFile = (typeof PAGES)[number]["file"];

const STYLE = `
:root{--bg:#fff;--fg:#1b1d21;--muted:#5d6470;--line:#d9dde3;--accent:#1f5fbf;--warn:#8a4b00;--warnbg:#fff4e0}
@media (prefers-color-scheme:dark){:root{--bg:#15171a;--fg:#e6e8eb;--muted:#a0a7b2;--line:#353a42;--accent:#7fb0ff;--warn:#ffcf8a;--warnbg:#3a2a10}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,sans-serif}
header,main,footer{max-width:960px;margin:0 auto;padding:0 16px}
header{border-bottom:1px solid var(--line);padding-top:16px}header p{margin:4px 0 12px;color:var(--muted)}
nav{display:flex;flex-wrap:wrap;gap:4px 16px;padding-bottom:12px}nav a{color:var(--accent);text-decoration:none}
nav a[aria-current]{font-weight:600;text-decoration:underline}
a{color:var(--accent)}code{font-size:.92em;overflow-wrap:anywhere}pre{overflow-x:auto;padding:12px;border:1px solid var(--line)}
.table{overflow-x:auto}table{border-collapse:collapse;margin:12px 0;width:100%}th,td{border:1px solid var(--line);padding:4px 8px;text-align:left;vertical-align:top}
.notice{border:2px solid var(--warn);background:var(--warnbg);color:var(--warn);padding:8px 12px;font-weight:600}
footer{border-top:1px solid var(--line);margin-top:32px;padding-top:12px;padding-bottom:24px;color:var(--muted);font-size:.9em}
`.trim();

/** One page: shared header, navigation and footer around `body`. */
export function page(file: PageFile, body: string): string {
  const title = PAGES.find((p) => p.file === file)?.title ?? "";
  const nav = PAGES.map(
    (p) => `<a href="${p.file}"${p.file === file ? ' aria-current="page"' : ""}>${e(p.title)}</a>`,
  ).join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(title)} | False-completion benchmark</title>
<style>${STYLE}</style>
</head>
<body>
<header>
<strong>Myco false-completion benchmark</strong>
<p>When a computer-use agent says "done", is the saved document actually right?</p>
<nav>${nav}</nav>
</header>
<main>
${body}
</main>
<footer>Generated from the benchmark package in the Myco repository (Apache-2.0). No leaderboard, no hosted service: every step runs locally from a clone.</footer>
</body>
</html>
`;
}

const wrapTables = (html: string) =>
  html.replaceAll("<table>", '<div class="table"><table>').replaceAll("</table>", "</table></div>");

/** A rendered Markdown page body. */
export const docPage = (file: PageFile, html: string) => page(file, wrapTables(html));

export function taskSetPage(cardHtml: string, version: string, tasks: readonly BenchmarkTask[]) {
  const rows = tasks
    .map(
      (t) =>
        `<tr><td><code>${e(t.taskId)}</code></td><td><code>${e(t.faultClass)}</code></td><td>${t.satisfiable ? "yes" : "no"}</td><td>${t.inDemo ? "yes" : "no"}</td><td>${e(t.instruction)}</td></tr>`,
    )
    .join("");
  const table = `<h2 id="all-tasks">All ${tasks.length} tasks of <code>${e(version)}</code></h2>
<p>Read from the committed, SHA-256-pinned <code>tasks.jsonl</code>. The instruction is the only text the agent receives.</p>
<div class="table"><table><thead><tr><th>Task</th><th>Fault class</th><th>Satisfiable</th><th>Demo</th><th>Instruction</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  return page("task-set.html", `${wrapTables(cardHtml)}\n${table}`);
}

export interface GraderModule {
  readonly path: string;
  readonly sha256: string;
}

export function graderPage(graderVersion: string, modules: readonly GraderModule[]) {
  const rows = modules
    .map((m) => `<tr><td><code>${e(m.path)}</code></td><td><code>${e(m.sha256)}</code></td></tr>`)
    .join("");
  return page(
    "grader.html",
    `<h1 id="grader">The independent grader</h1>
<p>Grader version: <code>${e(graderVersion)}</code>.</p>
<p>The grader reads only the saved document's bytes, the pristine fixture and the task's intent. A grade request has no field for the agent's claim, the arm, or any gate's verdict. It shares no code with the gate: the repository's independence test fails if any grader module imports outside the grader directory (Node built-ins aside), names a gate module, or reaches a process launcher.</p>
<p>Run it from a clone with Node only: <code>npx tsx scripts/benchmark-verify-bundle.ts benchmark/false-completion/fc-v1</code> checks the bundle against its manifest, and <code>npx tsx scripts/benchmark-grade.ts requests.jsonl</code> grades. The full procedure is on the <a href="protocol.html">grading protocol</a> page.</p>
<h2 id="modules">Grader modules</h2>
<p>The SHA-256 of each file at the time this site was built.</p>
<div class="table"><table><thead><tr><th>File</th><th>SHA-256</th></tr></thead><tbody>${rows}</tbody></table></div>`,
  );
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const rate = (
  r: Rate | { numerator: number; denominator: number; wilson95: readonly [number, number] | null },
) =>
  `${r.numerator} / ${r.denominator}${r.wilson95 === null ? " (no interval: denominator 0)" : ` (Wilson 95%: ${pct(r.wilson95[0])} to ${pct(r.wilson95[1])})`}`;
const exact = (r: { numerator: number; denominator: number; exact95: readonly [number, number] }) =>
  `${r.numerator} / ${r.denominator} (exact 95%: ${pct(r.exact95[0])} to ${pct(r.exact95[1])})`;
const usd = (x: number | null) => (x === null ? "unmeasured" : `$${x.toFixed(2)}`);

function resultSection(r: VerifiedResult): string {
  const fixture = r.kind === "test-fixture";
  const banner = fixture ? `<p class="notice">${e(FIXTURE_BANNER)}</p>\n` : "";
  const c = r.check;
  const parts: string[] = [
    `<h2 id="${e(r.id)}">${fixture ? "Test fixture" : "Result pack"} <code>${e(r.id)}</code></h2>`,
    banner,
    `<p>Task set <code>${e(r.taskSetVersion)}</code>. Pack digest (SHA-256 of <code>result.json</code>): <code>${e(r.manifestSha256)}</code>. Every number below was recomputed from the pack's committed ledgers when this site was built.</p>`,
  ];
  const arms = c.benchmark.arms
    .map(
      (a) =>
        `<tr><td><code>${e(a.arm)}</code></td><td>${a.trials}</td><td>${a.claimedDone}</td><td>${a.accepted}</td><td>${a.falseDoneAccepted}</td><td>${a.acceptedUngradable}</td><td>${rate(a.falseAcceptPerTrial)}</td></tr>`,
    )
    .join("");
  parts.push(
    `<h3>Arms</h3>${banner}<div class="table"><table><thead><tr><th>Arm</th><th>Trials</th><th>Claimed done</th><th>Accepted</th><th>False DONE accepted</th><th>Accepted ungradable</th><th>False accepts over all trials</th></tr></thead><tbody>${arms}</tbody></table></div>`,
  );
  if (c.r1 !== null) {
    const r1 = c.r1;
    parts.push(
      `<h3>R1 (gated arm)</h3>${banner}<div class="table"><table><tbody>
<tr><th>Verdict</th><td>${r1.pass ? "pass" : "not met"}</td></tr>
<tr><th>Headline: false DONEs accepted over all trials</th><td>${rate(r1.headline)}</td></tr>
<tr><th>Eligible gated trials</th><td>${r1.trials} (of which faulted: ${r1.faultTrials})</td></tr>
<tr><th>Unregistrable trials</th><td>${r1.unregistrable.trials} (claimed done: ${r1.unregistrable.claimedDone})</td></tr>
<tr><th>Ineligible gated trials</th><td>${r1.ineligible.count}</td></tr>
<tr><th>False-accept rate over eligible accepted DONEs</th><td>${rate(r1.falseAcceptRate)}</td></tr>
</tbody></table></div>`,
    );
  }
  if (c.r2 !== null) {
    const r2 = c.r2;
    parts.push(
      `<h3>R2 (paired arms)</h3>${banner}<p>${r2.pairs} pairs: both succeed ${r2.bothSucceed}, gated only ${r2.gateOnly}, shell only ${r2.shellOnly}, neither ${r2.neither}. Exact two-sided sign test p = ${r2.signTestP.toFixed(4)}${r2.underpowered ? " (underpowered)" : ""}.</p>`,
    );
  }
  if (c.r3 !== null) {
    const rows = c.r3.classes
      .map(
        (k) =>
          `<tr><td><code>${e(k.faultClass)}</code></td><td>${k.trials}</td><td>${exact(k.falseSuccess)}</td><td>${exact(k.detection)}</td></tr>`,
      )
      .join("");
    parts.push(
      `<h3>R3 (faulted trials, eligible)</h3>${banner}<div class="table"><table><thead><tr><th>Fault class</th><th>Eligible trials</th><th>False successes</th><th>Detection</th></tr></thead><tbody>${rows}</tbody></table></div>`,
    );
  }
  if (c.r7 !== null) {
    const rows = c.r7.arms
      .map(
        (a) =>
          `<tr><td><code>${e(a.arm)}</code></td><td>${a.verified}</td><td>${usd(a.modelUsd.perVerified)}</td></tr>`,
      )
      .join("");
    parts.push(
      `<h3>R7 (cost per verified task)</h3>${banner}<p>Cost basis: ${e(COST_BASIS)}.</p><div class="table"><table><thead><tr><th>Arm</th><th>Verified tasks</th><th>Estimated model cost per verified task</th></tr></thead><tbody>${rows}</tbody></table></div>`,
    );
  }
  return parts.join("\n");
}

/** The results page. Refuses any result that did not come from `verifyResultPack`. */
export function resultsPage(results: readonly VerifiedResult[]): string {
  for (const r of results) assertVerified(r);
  const intro = `<h1 id="results">Results</h1>
<p>This table is filled only from committed result packs whose files match their SHA-256 digests, recomputed at build time by the repository's evidence check. Simulated, experiment and unverified numbers are refused. There is no leaderboard and no third-party row without real runs.</p>`;
  if (results.length === 0)
    return page(
      "results.html",
      `${intro}
<p class="notice">${e(PLACEHOLDER)}.</p>
<div class="table"><table><thead><tr><th>Arm</th><th>Trials</th><th>False DONEs accepted</th><th>Rate</th></tr></thead><tbody>
<tr><td colspan="4">${e(PLACEHOLDER)}: no committed, digest-verified result pack exists.</td></tr>
</tbody></table></div>`,
    );
  return page("results.html", `${intro}\n${results.map(resultSection).join("\n")}`);
}
