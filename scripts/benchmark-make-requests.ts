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
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { benchmarkTaskSchema } from "../schemas/benchmark-ledger.ts";
import { validateSchema } from "../schemas/validate.ts";
import { type ArmRowRef, buildRequests } from "../src/benchmark/requests.ts";
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

const jsonl = (p: string) =>
  readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as unknown);

const tasks = jsonl(join(bundle, "tasks.jsonl")).map((t, i) => {
  const issues = validateSchema(t, benchmarkTaskSchema);
  if (issues.length > 0) {
    process.stderr.write(
      `tasks.jsonl line ${i + 1}: ${issues.map((s) => `${s.path} ${s.message}`).join("; ")}\n`,
    );
    process.exit(1);
  }
  return t as BenchmarkTask;
});
const rows = jsonl(armPath) as ArmRowRef[];
if (rows.length === 0) {
  process.stderr.write("arm ledger is empty\n");
  process.exit(1);
}

mkdirSync(join(out, "fixtures"), { recursive: true });
mkdirSync(join(out, "docs"), { recursive: true });
const requests = buildRequests(tasks, rows, (trialKey) => {
  for (const format of ["xlsx", "csv"] as const) {
    const src = join(docs, `${trialKey}.${format}`);
    if (existsSync(src)) {
      copyFileSync(src, join(out, "docs", `${trialKey}.${format}`));
      return { file: `docs/${trialKey}.${format}`, format };
    }
  }
  return null;
});
for (const req of requests) copyFileSync(join(bundle, req.fixtureFile), join(out, req.fixtureFile));
writeFileSync(
  join(out, "requests.jsonl"),
  `${requests.map((r) => JSON.stringify(r)).join("\n")}\n`,
);
process.stdout.write(`wrote ${requests.length} requests to ${join(out, "requests.jsonl")}\n`);
