#!/usr/bin/env node
/**
 * Replay recorded arm evidence through the pre-registered decision rule.
 *
 * Usage: tsx scripts/discovery-replay.ts <file...> [--out <summary.md>] [--report <report.md>]
 *
 * Accepts a C1 accounting file, a run directory's result.json, or a JSON/JSONL
 * array of scored trials. Nothing is fetched and no guest is touched.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { type ReplayInput, renderReplaySummary, replay } from "../src/discovery/replay.ts";
import { renderHeadToHeadReport } from "../src/discovery/report.ts";

const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const reportIndex = args.indexOf("--report");
const outPath = outIndex >= 0 ? args[outIndex + 1] : undefined;
const reportPath = reportIndex >= 0 ? args[reportIndex + 1] : undefined;
const files = args.filter(
  (_, index) =>
    index !== outIndex &&
    index !== outIndex + 1 &&
    index !== reportIndex &&
    index !== reportIndex + 1,
);
if (files.length === 0) {
  process.stderr.write(
    "usage: discovery-replay <file...> [--out <summary.md>] [--report <report.md>]\n",
  );
  process.exit(2);
}

const inputs: ReplayInput[] = [];
for (const file of files) {
  const text = readFileSync(file, "utf8");
  if (file.endsWith(".jsonl")) {
    const rows: unknown[] = [];
    for (const line of text.split("\n")) {
      if (line.trim().length === 0) continue;
      rows.push(JSON.parse(line));
    }
    inputs.push({ source: basename(file), value: rows });
  } else {
    inputs.push({ source: basename(file), value: JSON.parse(text) });
  }
}

const summary = replay(inputs);
const markdown = renderReplaySummary(summary);
process.stdout.write(markdown);
if (outPath) writeFileSync(outPath, markdown);

if (reportPath) {
  const arms = summary.arms.map((arm) => ({
    armId: arm.armId,
    trials: summary.trials.filter((trial) => trial.armId === arm.armId),
  }));
  writeFileSync(
    reportPath,
    renderHeadToHeadReport({
      decision: summary.decision,
      arms,
      notRun: [
        { armId: "hcu+shell", blocker: "needs the guest and Foundry's trusted ingest" },
        { armId: "screenshot-only", blocker: "C1 is Calc; ef-t01b needs a Windows todo run" },
      ],
      evidence: summary.sources,
      generatedAt: new Date().toISOString(),
    }),
  );
  process.stdout.write(`\nreport: ${reportPath}\n`);
}
