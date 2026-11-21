#!/usr/bin/env node
/**
 * Render a run directory (`result.json` [+ `trace.jsonl`]) to `report.html`.
 *
 * Invalid artifacts fail loudly and nothing is written: the report is display
 * only, so a malformed evidence bundle must not be turned into a readable page.
 *
 * Usage: tsx src/report/report-cli.ts <run-dir> [--out <file>]
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { resultRecordSchema } from "../../schemas/result-record.ts";
import { traceEventSchema } from "../../schemas/trace-events.ts";
import { validateSchema } from "../../schemas/validate.ts";
import {
  parseReportResult,
  parseTraceEvent,
  type ReportTraceEvent,
  renderReport,
} from "./report.ts";

function fail(message: string): never {
  process.stderr.write(`myco report: ${message}\n`);
  process.exit(2);
}

const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const outPath = outIndex >= 0 ? args[outIndex + 1] : undefined;
const runDir = args.find((arg, index) => index !== outIndex && index !== outIndex + 1);
if (!runDir) fail("usage: report-cli <run-dir> [--out <file>]");

const resolvedDir = resolve(runDir);
let resultText: string;
try {
  resultText = readFileSync(join(resolvedDir, "result.json"), "utf8");
} catch (error) {
  fail(`cannot read ${join(resolvedDir, "result.json")}: ${String(error)}`);
}

let resultJson: unknown;
try {
  resultJson = JSON.parse(resultText);
} catch (error) {
  fail(`result.json is not JSON: ${String(error)}`);
}

const resultIssues = validateSchema(resultJson, resultRecordSchema);
if (resultIssues.length > 0) {
  fail(
    `result.json violates the evidence schema: ${resultIssues
      .map((issue) => `${issue.path} ${issue.message}`)
      .join("; ")}`,
  );
}

const trace: ReportTraceEvent[] = [];
let traceText: string | undefined;
try {
  traceText = readFileSync(join(resolvedDir, "trace.jsonl"), "utf8");
} catch {
  traceText = undefined;
}
if (traceText !== undefined) {
  const lines = traceText.split("\n").filter((line) => line.trim().length > 0);
  for (const [index, line] of lines.entries()) {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch (error) {
      fail(`trace.jsonl line ${index + 1} is not JSON: ${String(error)}`);
    }
    const issues = validateSchema(event, traceEventSchema);
    if (issues.length > 0) {
      fail(
        `trace.jsonl line ${index + 1} violates the evidence schema: ${issues
          .map((issue) => `${issue.path} ${issue.message}`)
          .join("; ")}`,
      );
    }
    trace.push(parseTraceEvent(event));
  }
}

let files: string[];
try {
  files = readdirSync(resolvedDir)
    .filter((name) => name !== "report.html")
    .sort();
} catch {
  files = ["result.json"];
}

const html = renderReport({
  result: parseReportResult(resultJson),
  trace,
  files,
});
const target = outPath ? resolve(outPath) : join(resolvedDir, "report.html");
writeFileSync(target, html);
process.stdout.write(`${target}\n`);
