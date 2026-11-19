/**
 * M1-012 CI artifact validation: run a sample eval and validate every emitted
 * artifact (trace.jsonl, result.json, ledger.jsonl) against the schemas in
 * schemas/. Exits non-zero on the first invalid artifact.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runEvaluation } from "../src/core/eval.ts";
import { FakeSpreadsheetApp } from "../src/fake/app.ts";
import { delayedSave, focusChange, invalidTarget, killApp } from "../src/fake/faults.ts";
import { cellVerifier, setCellFamily } from "../src/fake/tasks.ts";
import { ledgerRowSchema } from "./ledger-row.ts";
import { resultRecordSchema } from "./result-record.ts";
import { traceEventSchema } from "./trace-events.ts";
import { type SchemaIssue, validateSchema } from "./validate.ts";

const dir = mkdtempSync(join(tmpdir(), "myco-schema-validate-"));
const file = (trial: number) => {
  const p = join(dir, `sheet-${trial}.csv`);
  writeFileSync(p, ",\n,\n,\n,\n");
  return p;
};

const summary = await runEvaluation({
  adapterFor: (t) => new FakeSpreadsheetApp({ filePath: file(t) }),
  verifier: cellVerifier,
  family: setCellFamily,
  faults: [killApp(), delayedSave(), focusChange(), invalidTarget(), { name: "none" }],
  trials: 5,
  filePathFor: file,
  runsDir: join(dir, "runs"),
  evalId: "ci-sample",
});

let failures = 0;
const report = (label: string, issues: SchemaIssue[]) => {
  if (issues.length > 0) {
    failures += 1;
    process.stderr.write(`INVALID ${label}`);
    for (const issue of issues) process.stderr.write(`  ${issue.path}: ${issue.message}`);
  } else {
    process.stdout.write(`ok ${label}`);
  }
};

if (summary.ledger === undefined || summary.ledger.unaccounted !== 0) {
  failures += 1;
  process.stderr.write("ledger accounting has unaccounted rows", summary.ledger);
}

const runsDir = join(dir, "runs");
for (const entry of readdirSync(runsDir)) {
  const runDir = join(runsDir, entry);
  const tracePath = join(runDir, "trace.jsonl");
  if (existsSync(tracePath)) {
    for (const [i, line] of readFileSync(tracePath, "utf8")
      .split("\n")
      .filter((l) => l !== "")
      .entries()) {
      report(`trace ${entry}[${i}]`, validateSchema(JSON.parse(line), traceEventSchema));
    }
    const resultPath = join(runDir, "result.json");
    report(
      `result ${entry}`,
      validateSchema(JSON.parse(readFileSync(resultPath, "utf8")), resultRecordSchema),
    );
  }
}
const ledgerPath = join(runsDir, "ci-sample", "ledger.jsonl");
if (existsSync(ledgerPath)) {
  for (const [i, line] of readFileSync(ledgerPath, "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .entries()) {
    report(`ledger row [${i}]`, validateSchema(JSON.parse(line), ledgerRowSchema));
  }
} else {
  failures += 1;
  process.stderr.write("missing ledger.jsonl");
}

rmSync(dir, { recursive: true, force: true });
if (failures > 0) {
  process.stderr.write(`${failures} artifact validation failure(s)`);
}
const ok = failures === 0;
if (ok) {
  process.stdout.write(`validated artifacts for ${summary.trials} trials (all ok)`);
}
// the fake app's delayed-save fault leaves a pending setTimeout that would keep
// the Node event loop alive for 60s; exit explicitly once validation is done
process.exit(ok ? 0 : 1);
