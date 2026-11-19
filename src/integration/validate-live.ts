/**
 * Validate the live M1-013 run artifacts against the schemas (same validator
 * CI uses). Usage: tsx src/integration/validate-live.ts [runsDir]
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resultRecordSchema } from "../../schemas/result-record.ts";
import { traceEventSchema } from "../../schemas/trace-events.ts";
import { validateSchema } from "../../schemas/validate.ts";

const runsDir = process.argv[2] ?? "runs/live-m1-013";
let failures = 0;
let traces = 0;
let results = 0;
for (const entry of readdirSync(runsDir)) {
  const runDir = join(runsDir, entry);
  const tracePath = join(runDir, "trace.jsonl");
  if (!existsSync(tracePath)) continue;
  for (const [i, line] of readFileSync(tracePath, "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .entries()) {
    const issues = validateSchema(JSON.parse(line), traceEventSchema);
    traces++;
    if (issues.length > 0) {
      failures++;
      process.stderr.write(`INVALID trace ${entry}[${i}]: ${JSON.stringify(issues)}\n`);
    }
  }
  const resultPath = join(runDir, "result.json");
  const issues = validateSchema(JSON.parse(readFileSync(resultPath, "utf8")), resultRecordSchema);
  results++;
  if (issues.length > 0) {
    failures++;
    process.stderr.write(`INVALID result ${entry}: ${JSON.stringify(issues)}\n`);
  }
}
process.stdout.write(
  `validated ${results} result.json + ${traces} trace events in ${runsDir}: ${failures === 0 ? "ALL OK" : `${failures} FAILURES`}\n`,
);
process.exit(failures === 0 ? 0 : 1);
