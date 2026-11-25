/** `myco-gate` CLI contract and the mock end-to-end demo (TIF-265). */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  EXIT_REFUTED,
  EXIT_UNCERTAIN,
  EXIT_USAGE,
  EXIT_VERIFIED,
  main,
} from "../../src/gate/cli.ts";
import { runMockDemo } from "../../src/gate/demo.ts";
import {
  CALC_SPEC,
  calcCsv,
  S01_ITEMS,
  S02_PERSISTED,
  tempRoot,
  todoStore,
  writeState,
} from "./helpers.ts";

async function run(argv: string[]) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = "";
  let err = "";
  stdout.on("data", (d) => {
    out += String(d);
  });
  stderr.on("data", (d) => {
    err += String(d);
  });
  const code = await main(argv, { stdin: new PassThrough(), stdout, stderr });
  return { code, out, err };
}

describe("myco-gate check", () => {
  const root = tempRoot();
  writeState(root, "ok", ".myco-todo.json", todoStore(S01_ITEMS));
  writeState(root, "dropped", ".myco-todo.json", todoStore(S02_PERSISTED));

  it("exit 0 on verified, 1 on refuted, 2 on uncertain", async () => {
    const base = ["check", "--evidence-root", root];
    expect((await run([...base, "--task", "df-s01", "--run", "ok"])).code).toBe(EXIT_VERIFIED);
    expect((await run([...base, "--task", "df-s02", "--run", "dropped"])).code).toBe(EXIT_REFUTED);
    expect((await run([...base, "--task", "df-s01", "--run", "missing"])).code).toBe(
      EXIT_UNCERTAIN,
    );
    expect((await run([...base, "--task", "df-s01", "--run", "../ok"])).code).toBe(EXIT_UNCERTAIN);
  });

  it("--json prints the GateResult; --audit appends one line per decision", async () => {
    const audit = join(tempRoot(), "decisions.jsonl");
    const { code, out } = await run([
      "check",
      "--evidence-root",
      root,
      "--task",
      "df-s02",
      "--run",
      "dropped",
      "--claim",
      "All 4 items added and saved.",
      "--audit",
      audit,
      "--json",
    ]);
    expect(code).toBe(EXIT_REFUTED);
    const result = JSON.parse(out);
    expect(result).toMatchObject({ verdict: "refuted", accepted: false });
    expect(
      readFileSync(audit, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l)),
    ).toEqual([result]);
  });

  it("--tasks registers operator tasks (a calc task)", async () => {
    const dir = tempRoot();
    const tasks = join(dir, "tasks.json");
    writeFileSync(
      tasks,
      JSON.stringify({
        tasks: [
          { id: "calc-1", family: "calc-record-edit", stateFile: "sheet.csv", spec: CALC_SPEC },
        ],
      }),
    );
    writeState(dir, "c", "sheet.csv", calcCsv(true));
    const { code } = await run([
      "check",
      "--evidence-root",
      dir,
      "--tasks",
      tasks,
      "--no-builtin",
      "--task",
      "calc-1",
      "--run",
      "c",
    ]);
    expect(code).toBe(EXIT_VERIFIED);
  });

  it.each([
    [["check", "--task", "df-s01", "--run", "ok"]],
    [["check", "--evidence-root", "/x", "--task", "df-s01"]],
    [["check", "--evidence-root"]],
    [["check", "--evidence-root", "/x", "--bogus"]],
    [["check", "--evidence-root", "/x", "--no-builtin", "--task", "a", "--run", "b"]],
    [["frobnicate"]],
    [["demo", "--transport", "live"]],
    [[]],
  ])("usage error → exit 3: %j", async (argv) => {
    expect((await run(argv)).code).toBe(EXIT_USAGE);
  });

  it("an invalid operator tasks file is a usage error, not a verdict", async () => {
    const dir = tempRoot();
    const tasks = join(dir, "tasks.json");
    writeFileSync(
      tasks,
      JSON.stringify({
        tasks: [{ id: "t", family: "todo-items", stateFile: "../x", spec: { items: ["a"] } }],
      }),
    );
    const { code, err } = await run([
      "check",
      "--evidence-root",
      dir,
      "--tasks",
      tasks,
      "--task",
      "t",
      "--run",
      "r",
    ]);
    expect(code).toBe(EXIT_USAGE);
    expect(err).toContain("invalid gate task registry");
  });
});

describe("myco-gate demo --transport mock (end to end, no VM, no model)", () => {
  it("accepts df-s01, rejects df-s02 as refuted, rejects the tamper attempt", async () => {
    const report = await runMockDemo({ outDir: tempRoot() });
    expect(report.tools).toEqual(["myco_gate_check"]);
    expect(report.rows.map((r) => [r.scenario, r.verdict, r.harness, r.asExpected])).toEqual([
      ["df-s01 clean save", "verified", "DONE accepted", true],
      ["df-s02 silent drop", "refuted", "DONE rejected", true],
      ["df-s02 agent tampers", "uncertain", "DONE rejected", true],
    ]);
    // The UI said "saved 4" in both runs; only the gate tells them apart.
    expect(new Set(report.rows.map((r) => r.uiStatus))).toEqual(new Set(["saved 4 item(s)"]));
    expect(report.ok).toBe(true);
    const logged = readFileSync(report.auditLog, "utf8").trim().split("\n");
    expect(logged).toHaveLength(3);
  }, 30_000);
});
