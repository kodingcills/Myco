/**
 * TIF-272 (M2-10, R3) — the M2 fault classes on the fake Calc app: no VM, no model.
 *
 *   pnpm exec tsx scripts/m2-fault-suite.ts run    --out DIR [--reps N]
 *   pnpm exec tsx scripts/m2-fault-suite.ts record DIR
 *   pnpm exec tsx scripts/m2-fault-suite.ts check  DIR --expect ROWS [--require-bar]
 *
 * `run` writes DIR/trials.jsonl (raw), then records DIR/ledger.jsonl and DIR/summary.json
 * and prints the per-class tables. It refuses a DIR that already has trials.jsonl.
 * `record` rebuilds ledger.jsonl and summary.json from trials.jsonl (byte-identical when
 * nothing was edited). `check` recomputes everything and exits 1 when the files are
 * inconsistent, empty or miscounted; with --require-bar also when the classes' bar fails.
 * Every row says what it is: this is the mock path, not M2-12's VM evidence.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runSuite, suitePlan } from "../src/faults/security/harness.ts";
import { checkSuite, jsonl, record, renderSummary } from "../src/faults/security/record.ts";

const USAGE = `usage:
  m2-fault-suite.ts run --out DIR [--reps N]
  m2-fault-suite.ts record DIR
  m2-fault-suite.ts check DIR --expect ROWS [--require-bar]
`;

function fail(message: string, code = 2): never {
  process.stderr.write(`${message}\n${USAGE}`);
  process.exit(code);
}

const [command, ...rest] = process.argv.slice(2);

function flag(name: string): string | undefined {
  const i = rest.indexOf(name);
  return i < 0 ? undefined : rest[i + 1];
}

function writeRecord(dir: string): void {
  const { ledger, summary } = record(readFileSync(join(dir, "trials.jsonl"), "utf8"));
  writeFileSync(join(dir, "ledger.jsonl"), ledger);
  writeFileSync(join(dir, "summary.json"), summary);
  process.stdout.write(renderSummary(JSON.parse(summary)));
}

if (command === "run") {
  const out = flag("--out") ?? fail("run needs --out DIR");
  const repsText = flag("--reps") ?? "2";
  if (!/^[1-9][0-9]*$/.test(repsText)) fail(`bad --reps ${repsText}`);
  mkdirSync(out, { recursive: true });
  if (existsSync(join(out, "trials.jsonl")))
    fail(`${out} already has trials.jsonl; use a fresh DIR`, 1);
  const trials = await runSuite(suitePlan(Number(repsText)));
  writeFileSync(join(out, "trials.jsonl"), jsonl(trials));
  writeRecord(out);
} else if (command === "record") {
  const dir = rest[0] ?? fail("record needs DIR");
  writeRecord(dir);
} else if (command === "check") {
  const dir = rest[0] ?? fail("check needs DIR");
  const expectText = flag("--expect") ?? fail("check needs --expect ROWS");
  if (!/^[1-9][0-9]*$/.test(expectText)) fail(`bad --expect ${expectText}`);
  const read = (name: string) => {
    const p = join(dir, name);
    return existsSync(p) ? readFileSync(p, "utf8") : "";
  };
  const result = checkSuite({
    trials: read("trials.jsonl"),
    ledger: read("ledger.jsonl"),
    summary: read("summary.json"),
    expectRows: Number(expectText),
  });
  for (const error of result.errors) process.stdout.write(`ERROR ${error}\n`);
  const bar = result.summary?.bar;
  process.stdout.write(`CHECK: ${result.ok ? "consistent" : "INCONSISTENT"}\n`);
  if (bar) process.stdout.write(`BAR: ${bar.pass ? "PASS" : "FAIL"}\n`);
  if (!result.ok) process.exit(1);
  if (rest.includes("--require-bar") && !bar?.pass) process.exit(1);
} else {
  fail(command ? `unknown command ${command}` : "no command");
}
