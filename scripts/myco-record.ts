/**
 * `myco-record`: track R, task recording to automation. A human demonstrates once; Myco
 * compiles the demonstration into a parameterized workflow with a derived oracle, and
 * replays it on a fresh fixture, verified by the gate and graded by the independent grader.
 *
 *   pnpm myco-record demo [--out DIR] [--calc]
 *   pnpm myco-record record --doc DOC.csv --out RECORDING.json [--marker TEXT]...
 *   pnpm myco-record compile --recording RECORDING.json --out DIR
 *   pnpm myco-record replay --compiled DIR --fixture CSV --evidence DIR --run-id ID
 *                           [--bind NAME=VALUE]... [--calc]
 *
 * `record` is operator-only: it needs an interactive terminal and a typed confirmation, and
 * prints a visible banner for the whole recording (Calc opens a visible window; close the
 * document or press ctrl+c to stop). `demo` uses a scripted human and marks every artifact
 * simulated. Everything is local; no model is called.
 *
 * Exit codes: 0 ok (demo: every scenario got its expected outcome), 1 refused or failed,
 * 3 usage error.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { type Compiled, CompileError, compileRecording } from "../src/recording/compile.ts";
import { calcRecorderSource, calcReplayActuator } from "../src/recording/linux-calc.ts";
import { recordDemonstration, serializeRecording } from "../src/recording/recorder.ts";
import { hermeticActuator, type ReplayReport, replayWorkflow } from "../src/recording/replay.ts";
import { cellFor, scriptedHuman } from "../src/recording/scripted-human.ts";
import type { Recording } from "../src/recording/types.ts";
import { generateFixture } from "../src/tasks/fixture.ts";

const USAGE = `usage: pnpm myco-record (demo | record | compile | replay) [options]  (see scripts/myco-record.ts)`;

const out = (line: string) => process.stdout.write(`${line}\n`);
const err = (line: string) => process.stderr.write(`${line}\n`);

function flags(argv: readonly string[]): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i] as string;
    if (!f.startsWith("--")) throw new Error(`unexpected argument ${f}`);
    const boolean = f === "--calc";
    const v = boolean ? "true" : argv[++i];
    if (v === undefined) throw new Error(`${f} needs a value`);
    m.set(f, [...(m.get(f) ?? []), v]);
  }
  return m;
}

const one = (m: Map<string, string[]>, f: string, fallback?: string): string => {
  const v = m.get(f)?.[0] ?? fallback;
  if (v === undefined) throw new Error(`${f} is required`);
  return v;
};

function summary(r: ReplayReport): string {
  if (r.outcome === "refused") return `REFUSED ${r.refusal?.code}: ${r.refusal?.detail}`;
  return `gate ${r.gate?.verdict?.toUpperCase()} (${r.gate?.family}, ${r.trust}) | grader ${r.grade?.status} | agree ${String(r.agree)}`;
}

async function demo(m: Map<string, string[]>): Promise<number> {
  const dir = resolve(one(m, "--out", join(tmpdir(), "myco-record-demo")));
  mkdirSync(dir, { recursive: true });
  const calc = m.has("--calc");
  const demoDoc = new TextEncoder().encode(generateFixture("track-r-demo").csv);
  const fresh = new TextEncoder().encode(generateFixture("track-r-demo-fresh").csv);
  const cell = cellFor(demoDoc, "EMP-0005", "name");
  const steps = [
    { do: "select", cell } as const,
    { do: "type", cell, text: "Demonstrated Name" } as const,
    { do: "save" } as const,
  ];
  const docPath = join(dir, "demonstration.csv");
  writeFileSync(docPath, demoDoc);
  const source = calc
    ? calcRecorderSource({ docPath, headless: true, script: steps })
    : scriptedHuman({ document: demoDoc, steps });
  out(`1. record (scripted human${calc ? ", real Calc via UNO listeners" : ", hermetic"})`);
  const rec = await recordDemonstration(source, {
    start: { startedBy: "operator", interactive: false },
    indicator: err,
    before: demoDoc,
    simulated: true,
    recordingId: "demo",
  });
  writeFileSync(join(dir, "recording.json"), serializeRecording(rec));
  out(
    `   ${rec.actions.length} actions, ${rec.droppedFields} raw fields dropped, ${rec.redactions.length} redactions`,
  );
  out("2. compile");
  const compiled = compileRecording(rec);
  writeFileSync(join(dir, "compiled.json"), `${JSON.stringify(compiled, null, 2)}\n`);
  out(
    `   ${compiled.workflow.workflowId}: parameters ${compiled.workflow.parameters.map((p) => p.name).join(", ")}`,
  );
  out(`   derived oracle: ${compiled.oracle.assertions.map((a) => a.type).join(", ")}`);
  out("3. replay on a fresh fixture (another seed)");
  const actuator = calc ? calcReplayActuator() : hermeticActuator();
  const scenarios = [
    { name: "honest", actuator, want: { verdict: "verified", grade: "pass" } },
    {
      name: "skip-save",
      actuator: hermeticActuator("skip-save"),
      want: { verdict: "refuted", grade: "fail" },
    },
  ];
  let ok = true;
  for (const s of scenarios) {
    const r = await replayWorkflow({
      compiled,
      bindings: { record: "EMP-0003", name: "Bound Name" },
      fixture: fresh,
      actuator: s.actuator,
      evidenceRoot: join(dir, "evidence"),
      runId: `replay-${s.name}`,
    });
    writeFileSync(join(dir, `replay-${s.name}.json`), `${JSON.stringify(r, null, 2)}\n`);
    const pass = r.gate?.verdict === s.want.verdict && r.grade?.status === s.want.grade;
    ok &&= pass;
    out(`   ${pass ? "PASS" : "FAIL"}  ${s.name.padEnd(10)} ${summary(r)}`);
  }
  out(`artifacts: ${dir}`);
  out("simulated: a scripted human; derived oracle; never R1 evidence");
  return ok ? 0 : 1;
}

async function record(m: Map<string, string[]>): Promise<number> {
  const doc = resolve(one(m, "--doc"));
  const dest = resolve(one(m, "--out"));
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    err("record is operator-only: run it from an interactive terminal");
    return 1;
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await rl.question(
    "Type RECORD to start recording this document (it will be visible): ",
  );
  rl.close();
  if (answer.trim() !== "RECORD") {
    err("not started");
    return 1;
  }
  const before = new Uint8Array(readFileSync(doc));
  const rec = await recordDemonstration(calcRecorderSource({ docPath: doc }), {
    start: { startedBy: "operator", interactive: true },
    indicator: err,
    before,
    simulated: false,
    recordingId: `rec-${Date.now()}`,
    markers: m.get("--marker") ?? [],
  });
  writeFileSync(dest, serializeRecording(rec, m.get("--marker") ?? []));
  out(`recorded ${rec.actions.length} actions (${rec.redactions.length} redactions)`);
  return 0;
}

function compile(m: Map<string, string[]>): number {
  const rec = JSON.parse(readFileSync(resolve(one(m, "--recording")), "utf8")) as Recording;
  const dir = resolve(one(m, "--out"));
  try {
    const compiled = compileRecording(rec);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "compiled.json"), `${JSON.stringify(compiled, null, 2)}\n`);
    out(`${compiled.workflow.workflowId}: ${compiled.workflow.steps.length} steps`);
    return 0;
  } catch (error) {
    if (error instanceof CompileError) {
      err(`refused: ${error.code}`);
      return 1;
    }
    throw error;
  }
}

async function replay(m: Map<string, string[]>): Promise<number> {
  const compiled = JSON.parse(
    readFileSync(join(resolve(one(m, "--compiled")), "compiled.json"), "utf8"),
  ) as Compiled;
  const bindings = Object.fromEntries(
    (m.get("--bind") ?? []).map((b) => {
      const i = b.indexOf("=");
      if (i < 1) throw new Error("--bind takes NAME=VALUE");
      return [b.slice(0, i), b.slice(i + 1)];
    }),
  );
  const r = await replayWorkflow({
    compiled,
    bindings,
    fixture: new Uint8Array(readFileSync(resolve(one(m, "--fixture")))),
    actuator: m.has("--calc") ? calcReplayActuator() : hermeticActuator(),
    evidenceRoot: resolve(one(m, "--evidence")),
    runId: one(m, "--run-id"),
  });
  out(JSON.stringify(r, null, 2));
  return r.outcome === "replayed" ? 0 : 1;
}

async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  let m: Map<string, string[]>;
  try {
    m = flags(rest);
  } catch (error) {
    err(`${(error as Error).message}\n${USAGE}`);
    return 3;
  }
  try {
    switch (command) {
      case "demo":
        return await demo(m);
      case "record":
        return await record(m);
      case "compile":
        return compile(m);
      case "replay":
        return await replay(m);
      default:
        err(USAGE);
        return 3;
    }
  } catch (error) {
    if (error instanceof Error && /is required|needs a value|takes NAME/.test(error.message)) {
      err(`${error.message}\n${USAGE}`);
      return 3;
    }
    err(`failed: ${error instanceof Error ? error.name : "error"}`);
    return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
