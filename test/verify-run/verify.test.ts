/**
 * `myco verify` on mock evidence (spec #589 §3, V1 subset; issue #666). Every decision-log line
 * here is written by a real gate (`createGate`) bound to the trial, through its `onDecision`.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { buildRegistry, createGate, fileEvidenceReader } from "../../src/gate/gate.ts";
import { builtinTasks } from "../../src/gate/tasks.ts";
import { compileIdentity, SHAPES_ONLY } from "../../src/proof/identity.ts";
import { verifyMain } from "../../src/verify-run/cli.ts";
import { exitCodeFor, outputId, verifyRun } from "../../src/verify-run/verify.ts";
import { S01_ITEMS, S02_PERSISTED, tempRoot, todoStore, writeState } from "../gate/helpers.ts";
import { treeSnapshot } from "../watch/helpers.ts";

const STORE = ".myco-todo.json";
const MARKER = "PLANTED_FAKE_MARKER";
const TASKS = buildRegistry(builtinTasks());

/** A real gate bound to (task, run) over `root`; returns its own decision log after `calls`. */
async function ownLog(
  root: string,
  binding: { taskId: string; runId: string },
  calls: readonly unknown[],
  shared?: string[],
): Promise<Buffer> {
  const lines: string[] = shared ?? [];
  const gate = createGate({
    tasks: TASKS,
    reader: fileEvidenceReader(root),
    assignment: binding,
    onDecision: (r) => {
      lines.push(`${JSON.stringify(r)}\n`);
    },
  });
  for (const call of calls) await gate.check(call);
  return Buffer.from(lines.join(""));
}

function evidence() {
  const root = tempRoot();
  writeState(root, "run-honest", STORE, todoStore(S01_ITEMS));
  writeState(root, "run-false", STORE, todoStore(S02_PERSISTED));
  return root;
}

const honest = { taskId: "df-s01", runId: "run-honest" };
const falseDone = { taskId: "df-s02", runId: "run-false" };

describe("verify on mock evidence (VA-01, VA-02, VA-13 subset)", () => {
  it("an honest run verifies (exit 0); its logged call agrees", async () => {
    const root = evidence();
    const log = await ownLog(root, honest, [{ ...honest, claim: "done" }]);
    const result = await verifyRun({
      ...honest,
      tasks: TASKS,
      evidenceRoot: root,
      decisionLog: log,
      guard: SHAPES_ONLY,
    });
    expect(result).toMatchObject({
      schema: "myco.verify/1",
      runId: "run-honest",
      taskId: "df-s01",
      verdict: "verified",
      reasonCodes: ["ORACLE_PASS"],
      verifyCodes: [],
      trust: "mock",
      simulated: true,
      agentReported: [],
      bundle: null,
    });
    expect(result.calls).toEqual([
      {
        call: 1,
        source: "decision-log",
        verdictForCall: "verified",
        reasonCodes: ["ORACLE_PASS", "CLAIM_RECORDED"],
        loggedVerdictAgrees: true,
      },
    ]);
    expect(exitCodeFor(result)).toBe(0);
  });

  it("a false done is refuted (exit 1); a call naming another run is this run's, recomputed ASSIGNMENT_MISMATCH", async () => {
    const root = evidence();
    const log = await ownLog(root, falseDone, [
      { ...falseDone, claim: "all 4 saved" },
      { ...honest, claim: "done" },
    ]);
    const result = await verifyRun({
      ...falseDone,
      tasks: TASKS,
      evidenceRoot: root,
      decisionLog: log,
      guard: SHAPES_ONLY,
    });
    expect(result.verdict).toBe("refuted");
    expect(result.verifyCodes).toEqual([]);
    expect(
      result.calls.map((c) => [c.call, c.verdictForCall, c.reasonCodes[0], c.loggedVerdictAgrees]),
    ).toEqual([
      [1, "refuted", "ORACLE_FAIL", true],
      [2, "uncertain", "ASSIGNMENT_MISMATCH", true],
    ]);
    expect(exitCodeFor(result)).toBe(1);
  });

  it("parse rejections (S1) are reported, never compared; they cannot move the verdict", async () => {
    const root = evidence();
    const log = await ownLog(root, falseDone, [
      { ...falseDone, extra: 1 },
      { ...falseDone, claim: 5 },
      { ...falseDone, state: "x", claim: "done" },
      { ...falseDone, apiVersion: "myco.gate/v9" },
      falseDone,
    ]);
    const result = await verifyRun({
      ...falseDone,
      tasks: TASKS,
      evidenceRoot: root,
      decisionLog: log,
      guard: SHAPES_ONLY,
    });
    expect(result.verdict).toBe("refuted");
    expect(result.verifyCodes).toEqual([]);
    expect(result.calls.map((c) => c.loggedVerdictAgrees)).toEqual([null, null, null, null, true]);
  });

  it("a call that read no evidence or older evidence is not compared (v5 comparison set)", async () => {
    const root = tempRoot();
    // Before the agent saved: STATE_MISSING. Then an old save, then the final save.
    const lines: string[] = [];
    await ownLog(root, falseDone, [falseDone], lines);
    writeState(root, "run-false", STORE, todoStore(["one old item"]));
    await ownLog(root, falseDone, [falseDone], lines);
    writeState(root, "run-false", STORE, todoStore(S02_PERSISTED));
    const log = await ownLog(root, falseDone, [falseDone], lines);
    const result = await verifyRun({
      ...falseDone,
      tasks: TASKS,
      evidenceRoot: root,
      decisionLog: log,
      guard: SHAPES_ONLY,
    });
    expect(result.calls.map((c) => c.loggedVerdictAgrees)).toEqual([null, null, true]);
    expect(result).toMatchObject({ verdict: "refuted", verifyCodes: [] });
  });

  it("a logged verdict rewritten over the same evidence: uncertain VERIFY_LOG_DISAGREES (exit 2)", async () => {
    const root = evidence();
    const log = await ownLog(root, falseDone, [falseDone]);
    const forged = JSON.parse(log.toString()) as Record<string, unknown>;
    forged.verdict = "verified";
    forged.accepted = true;
    forged.reasonCodes = ["ORACLE_PASS"];
    const result = await verifyRun({
      ...falseDone,
      tasks: TASKS,
      evidenceRoot: root,
      decisionLog: Buffer.from(`${JSON.stringify(forged)}\n`),
      guard: SHAPES_ONLY,
    });
    expect(result).toMatchObject({ verdict: "uncertain", verifyCodes: ["VERIFY_LOG_DISAGREES"] });
    expect(result.calls[0]?.loggedVerdictAgrees).toBe(false);
    expect(exitCodeFor(result)).toBe(2);
  });

  it("a log shared by two gates, or a malformed line: uncertain VERIFY_LOG_BINDING, no call compared", async () => {
    const root = evidence();
    const shared: string[] = [];
    await ownLog(root, honest, [honest], shared);
    const log = await ownLog(root, falseDone, [falseDone], shared);
    for (const binding of [honest, falseDone]) {
      const result = await verifyRun({
        ...binding,
        tasks: TASKS,
        evidenceRoot: root,
        decisionLog: log,
        guard: SHAPES_ONLY,
      });
      expect(result).toMatchObject({
        verdict: "uncertain",
        verifyCodes: ["VERIFY_LOG_BINDING"],
        calls: [],
      });
    }
    const own = await ownLog(root, falseDone, [falseDone]);
    const malformed = Buffer.concat([own, Buffer.from("{not json\n")]);
    const result = await verifyRun({
      ...falseDone,
      tasks: TASKS,
      evidenceRoot: root,
      decisionLog: malformed,
      guard: SHAPES_ONLY,
    });
    expect(result.verifyCodes).toEqual(["VERIFY_LOG_BINDING"]);
  });

  it("without a log it decides from the evidence alone; the log never overrides the recompute", async () => {
    const root = evidence();
    const result = await verifyRun({
      ...falseDone,
      tasks: TASKS,
      evidenceRoot: root,
      guard: SHAPES_ONLY,
    });
    expect(result).toMatchObject({ verdict: "refuted", calls: [], trust: "mock", simulated: true });
  });
});

describe("read-only and identity-safe", () => {
  it("leaves the evidence root and the log byte-identical", async () => {
    const root = evidence();
    const logPath = join(tempRoot(), "log.jsonl");
    writeFileSync(logPath, await ownLog(root, falseDone, [{ ...falseDone, claim: MARKER }]));
    const before = treeSnapshot(root);
    const logBefore = readFileSync(logPath);
    const out = capture();
    const code = await verifyMain(
      [
        "run-false",
        "--task",
        "df-s02",
        "--mock-evidence",
        root,
        "--decision-log",
        logPath,
        "--json",
      ],
      out.io,
    );
    expect(code).toBe(1);
    expect(treeSnapshot(root)).toEqual(before);
    expect(readFileSync(logPath)).toEqual(logBefore);
    expect(readdirSync(root).sort()).toEqual(["run-false", "run-honest"]);
    // No claim, path, reason text or evidence path in the output.
    const text = out.out();
    expect(text).not.toContain(MARKER);
    expect(text).not.toContain(root);
    expect(text).not.toContain(STORE);
    for (const key of ["reasons", "evidenceRefs", "claim", "path"])
      expect(text).not.toContain(`"${key}"`);
  });

  it("an id carrying an identity is output as h-<60hex>, never as written", () => {
    const guard = compileIdentity({ names: ["planted-fake-user"], homes: [] });
    expect(outputId("run-planted-fake-user", guard)).toMatch(/^h-[0-9a-f]{60}$/);
    expect(outputId("run-r", guard)).toBe("run-r");
  });

  it("the verify module never reaches the independent grader (grader independence)", () => {
    const seen = new Set<string>();
    const walk = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/from\s+"(\.{1,2}\/[^"]+)"/g))
        walk(resolve(file, "..", m[1] as string));
    };
    walk(resolve(import.meta.dirname, "..", "..", "src", "verify-run", "cli.ts"));
    for (const file of seen) expect(file, file).not.toContain(join("src", "benchmark", "grade"));
    expect([...seen].some((f) => f.endsWith(join("src", "gate", "gate.ts")))).toBe(true);
  });
});

function capture() {
  let out = "";
  let err = "";
  const sink = (append: (s: string) => void) =>
    new Writable({
      write(chunk, _e, done) {
        append(String(chunk));
        done();
      },
    });
  return {
    io: { stdout: sink((s) => (out += s)), stderr: sink((s) => (err += s)) },
    out: () => out,
    err: () => err,
  };
}

describe("myco verify CLI (VA-01 subset)", () => {
  it("usage errors exit 3: no source, unsafe ids, and every source or output not in this build", async () => {
    const root = evidence();
    for (const argv of [
      ["run-false", "--task", "df-s02"],
      ["../x", "--task", "df-s02", "--mock-evidence", root],
      ["run-false", "--task", "a/b", "--mock-evidence", root],
      ["run-false", "--task", "df-s02", "--mock-evidence", root, "--vault", root],
      ["run-false", "--task", "df-s02", "--mock-evidence", root, "--recording", root],
      ["run-false", "--task", "df-s02", "--mock-evidence", root, "--out", join(root, "b.json")],
      ["run-false", "--task", "df-s02", "--mock-evidence", root, "--transcript", "t"],
      ["run-false", "run-honest", "--task", "df-s02", "--mock-evidence", root],
      [
        "run-false",
        "--task",
        "df-s02",
        "--mock-evidence",
        root,
        "--decision-log",
        join(root, "missing"),
      ],
      [],
    ]) {
      const c = capture();
      expect(await verifyMain(argv, c.io), argv.join(" ")).toBe(3);
      expect(c.err()).not.toContain(root);
    }
    expect(readdirSync(root).sort()).toEqual(["run-false", "run-honest"]);
  });

  it("exit codes follow the verdict: 0 verified, 1 refuted, 2 uncertain", async () => {
    const root = evidence();
    expect(
      await verifyMain(["run-honest", "--task", "df-s01", "--mock-evidence", root], capture().io),
    ).toBe(0);
    expect(
      await verifyMain(["run-false", "--task", "df-s02", "--mock-evidence", root], capture().io),
    ).toBe(1);
    expect(
      await verifyMain(["run-gone", "--task", "df-s02", "--mock-evidence", root], capture().io),
    ).toBe(2);
  });
});
