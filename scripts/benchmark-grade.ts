/**
 * Independent grader CLI for the false-completion benchmark (TIF-267).
 *
 *   npx tsx scripts/benchmark-grade.ts <requests.jsonl> > grades.jsonl
 *
 * Each request line: { trialKey, taskId, fixtureSha256, fixtureFile, persistedFile|null,
 * persistedFormat: "xlsx"|"csv", intent: {rowKey, column, newValue}, columnTypes }.
 * File paths are relative to the requests file and are read, never echoed: the grade row
 * carries hashes only. A request has no field for the agent's claim or the gate verdict.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { benchmarkGradeRequestSchema } from "../schemas/benchmark-ledger.ts";
import { validateSchema } from "../schemas/validate.ts";
import { type ColumnType, grade } from "../src/benchmark/grade/grade.ts";
import { gradeRow } from "../src/benchmark/grade/row.ts";

interface GradeRequest {
  trialKey: string;
  taskId: string;
  fixtureSha256: string;
  fixtureFile: string;
  persistedFile: string | null;
  persistedFormat: "xlsx" | "csv";
  intent: { rowKey: string; column: string; newValue: string };
  columnTypes: Record<string, ColumnType>;
}

const path = process.argv[2];
if (path === undefined) {
  process.stderr.write("usage: benchmark-grade.ts <requests.jsonl>\n");
  process.exit(2);
}
const base = dirname(resolve(path));
const local = (p: string) => {
  if (isAbsolute(p) || p.split(/[\\/]/).includes("..")) {
    throw new Error(`request paths must be relative and inside the request directory: ${p}`);
  }
  return resolve(base, p);
};

const lines = readFileSync(path, "utf8")
  .split("\n")
  .filter((l) => l.trim() !== "");
if (lines.length === 0) {
  process.stderr.write("no grade requests\n");
  process.exit(1);
}
for (const line of lines) {
  const parsed: unknown = JSON.parse(line);
  const issues = validateSchema(parsed, benchmarkGradeRequestSchema);
  const types = (parsed as { columnTypes?: Record<string, unknown> }).columnTypes ?? {};
  const badType = Object.entries(types).find(
    ([, t]) => !["key", "text", "integer", "date", "currency"].includes(t as string),
  );
  if (issues.length > 0 || badType !== undefined) {
    process.stderr.write(
      `invalid grade request: ${issues.map((i) => `${i.path} ${i.message}`).join("; ")}${badType ? ` columnTypes.${badType[0]} is not a column type` : ""}\n`,
    );
    process.exit(1);
  }
  const req = parsed as GradeRequest;
  const persistedPath = req.persistedFile === null ? null : local(req.persistedFile);
  const result = grade({
    fixtureCsv: readFileSync(local(req.fixtureFile)),
    fixtureSha256: req.fixtureSha256,
    persisted:
      persistedPath !== null && existsSync(persistedPath)
        ? { format: req.persistedFormat, bytes: readFileSync(persistedPath) }
        : null,
    intent: req.intent,
    columnTypes: req.columnTypes,
  });
  process.stdout.write(`${JSON.stringify(gradeRow(req.trialKey, req.taskId, result))}\n`);
}
