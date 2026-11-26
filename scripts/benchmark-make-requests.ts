/**
 * Build grade requests for an arm from the published bundle (TIF-267 part 2).
 *
 *   npx tsx scripts/benchmark-make-requests.ts --bundle <bundle dir> --arm arm.jsonl \
 *     --docs <dir of <trialKey>.xlsx|.csv> --out <work dir>
 *
 * Writes <work>/requests.jsonl, with copies of the fixtures under <work>/fixtures/ and of
 * the saved documents under <work>/docs/, so every request path is relative and inside the
 * work directory (the grader refuses anything else). A trial with no saved document gets
 * `persistedFile: null` and grades `ungradable`.
 *
 * The arm file is untrusted input. Every row is validated against the closed arm-row schema
 * and checked against its task before any path is built, and every path read or written is
 * asserted to stay inside --bundle, --docs or --out. On any refusal it exits 1 having
 * written nothing.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { benchmarkArmRowSchema, benchmarkTaskSchema } from "../schemas/benchmark-ledger.ts";
import { validateSchema } from "../schemas/validate.ts";
import {
  type ArmRowRef,
  buildRequests,
  pathInside,
  RequestBuildError,
} from "../src/benchmark/requests.ts";
import type { BenchmarkTask } from "../src/benchmark/taskset.ts";

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  const v = i >= 0 ? args[i + 1] : undefined;
  if (v === undefined) {
    process.stderr.write(
      `usage: benchmark-make-requests.ts --bundle <dir> --arm <jsonl> --docs <dir> --out <dir> (missing ${name})\n`,
    );
    process.exit(2);
  }
  return v;
};
const bundle = opt("--bundle");
const armPath = opt("--arm");
const docs = opt("--docs");
const out = opt("--out");

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const jsonl = (p: string, label: string) =>
  readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l, i) => {
      try {
        return JSON.parse(l) as unknown;
      } catch {
        return fail(`${label} line ${i + 1}: not JSON`);
      }
    });

const validated = <T>(rows: unknown[], schema: typeof benchmarkTaskSchema, label: string): T[] =>
  rows.map((row, i) => {
    const issues = validateSchema(row, schema);
    if (issues.length > 0)
      fail(`${label} line ${i + 1}: ${issues.map((s) => `${s.path} ${s.message}`).join("; ")}`);
    return row as T;
  });

const copies: { src: string; dst: string }[] = [];
let requests: ReturnType<typeof buildRequests>;
try {
  const tasks = validated<BenchmarkTask>(
    jsonl(pathInside(bundle, "tasks.jsonl"), "tasks.jsonl"),
    benchmarkTaskSchema,
    "tasks.jsonl",
  );
  const rows = validated<ArmRowRef>(jsonl(armPath, "arm"), benchmarkArmRowSchema, "arm");
  if (rows.length === 0) fail("arm ledger is empty");
  requests = buildRequests(tasks, rows, (trialKey) => {
    for (const format of ["xlsx", "csv"] as const) {
      const name = `${trialKey}.${format}`;
      const src = pathInside(docs, name);
      if (existsSync(src)) {
        copies.push({ src, dst: pathInside(out, `docs/${name}`) });
        return { file: `docs/${name}`, format };
      }
    }
    return null;
  });
  for (const req of requests) {
    copies.push({
      src: pathInside(bundle, req.fixtureFile),
      dst: pathInside(out, req.fixtureFile),
    });
  }
} catch (e) {
  if (e instanceof RequestBuildError) fail(`RequestBuildError: ${e.message}`);
  throw e;
}

// Nothing is written until every row and every path has been checked.
for (const { src, dst } of copies) {
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst);
}
const requestsPath = pathInside(out, "requests.jsonl");
mkdirSync(dirname(requestsPath), { recursive: true });
writeFileSync(requestsPath, `${requests.map((r) => JSON.stringify(r)).join("\n")}\n`);
process.stdout.write(`wrote ${requests.length} requests to ${requestsPath}\n`);
