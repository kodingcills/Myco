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
const optionValue = (flag: string): string | undefined => {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    process.stderr.write(`discovery-replay: ${flag} needs a value\n`);
    process.exit(2);
  }
  return value;
};
const outPath = optionValue("--out");
const reportPath = optionValue("--report");
const optionIndexes = new Set<number>();
for (const flag of ["--out", "--report"]) {
  const index = args.indexOf(flag);
  if (index >= 0) {
    optionIndexes.add(index);
    optionIndexes.add(index + 1);
  }
}
const files = args.filter((_, index) => !optionIndexes.has(index));
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
