/**
 * Capability track I: gate and grader independence from the structured-state tools.
 *
 * - No gate module (src/gate/) reaches src/state/ through its transitive import graph, so
 *   the gate's verdict cannot depend on these tools: it keeps reading only the persisted
 *   bytes it captures itself.
 * - No grader module (src/benchmark/grade/) reaches src/state/ (also enforced by the
 *   extended test/benchmark/independence.test.ts), and no state module reaches the grader.
 * - The state core (api, backend, server, cli, linux backends) stays inside src/state/:
 *   it imports no gate, benchmark or integrity code. No state module (arms.ts included)
 *   reaches src/gate/, the grader, `groundTruth` (src/tasks/intent.ts) or the fixture
 *   generator, even transitively (capability spec §1.2 rule 4). The `myco-state` script may
 *   reach src/gate/ only for the pure stdin frame cap (`stdio-frame.ts`).
 * - The gate's request is unchanged by this track: `GATE_REQUEST_SCHEMA` and
 *   `ORACLE_INPUT_FIELDS` are pinned by hash (spec §1.2 rule 1).
 * - The gate decides the same over the same captured bytes whether or not a state server
 *   was attached and called during the trial (spec §1.2 rule 3).
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { registerTask } from "../../src/benchmark/gated-rows.ts";
import { scriptedDocument } from "../../src/benchmark/r1-dryrun.ts";
import { buildTaskSet } from "../../src/benchmark/taskset.ts";
import { GATE_REQUEST_SCHEMA, ORACLE_INPUT_FIELDS } from "../../src/gate/api.ts";
import { runGatedTrial } from "../../src/gate/gated-trial.ts";
import { newVaultKey, VerdictVault } from "../../src/integrity/vault.ts";
import { capabilityArmPlan } from "../../src/state/arms.ts";
import { createStateService } from "../../src/state/server.ts";
import { fakeBackend } from "./fake-backend.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");
const STATE = join(ROOT, "src", "state");
const GRADE = join(ROOT, "src", "benchmark", "grade");

const IMPORT =
  /(?:import|export)\s[^;]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|require\s*\(\s*["']([^"']+)["']\s*\)|import\s+["']([^"']+)["']/g;

function specifiers(source: string): string[] {
  return [...source.matchAll(IMPORT)].map((m) => (m[1] ?? m[2] ?? m[3] ?? m[4]) as string);
}

function walk(entry: string, seen = new Map<string, string[]>()): Map<string, string[]> {
  if (seen.has(entry)) return seen;
  const specs = specifiers(readFileSync(entry, "utf8"));
  seen.set(entry, specs);
  for (const spec of specs) if (spec.startsWith(".")) walk(resolve(dirname(entry), spec), seen);
  return seen;
}

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? tsFiles(join(dir, e.name))
      : e.name.endsWith(".ts")
        ? [join(dir, e.name)]
        : [],
  );
}

describe("gate independence from myco-state", () => {
  const gateFiles = tsFiles(join(ROOT, "src", "gate"));

  it("has gate modules to check", () => {
    expect(gateFiles.length).toBeGreaterThanOrEqual(10);
  });

  it("no gate module reaches src/state/", () => {
    const hits: string[] = [];
    for (const file of gateFiles)
      for (const mod of walk(file).keys())
        if (mod.startsWith(`${STATE}/`))
          hits.push(`${relative(ROOT, file)} -> ${relative(ROOT, mod)}`);
    expect(hits).toEqual([]);
  });

  it("no gate module names the state server or its tools", () => {
    for (const file of gateFiles)
      expect(readFileSync(file, "utf8"), relative(ROOT, file)).not.toMatch(
        /myco-state|state_read_range|src\/state/,
      );
  });
});

describe("grader independence from myco-state", () => {
  it("no grader module reaches src/state/", () => {
    for (const file of tsFiles(GRADE))
      for (const mod of walk(file).keys())
        expect(mod.startsWith(`${STATE}/`), relative(ROOT, file)).toBe(false);
  });

  it("no state module reaches the grader", () => {
    for (const file of tsFiles(STATE))
      for (const mod of walk(file).keys())
        expect(mod.startsWith(`${GRADE}/`), relative(ROOT, file)).toBe(false);
  });
});

describe("no state module reaches gate, grader or ground-truth code", () => {
  const forbidden = [
    `${join(ROOT, "src", "gate")}/`,
    `${GRADE}/`,
    join(ROOT, "src", "tasks", "intent.ts"),
    join(ROOT, "src", "tasks", "fixture.ts"),
  ];
  it("holds for every module under src/state/, arms.ts included", () => {
    const hits: string[] = [];
    for (const file of tsFiles(STATE))
      for (const mod of walk(file).keys())
        if (forbidden.some((f) => mod.startsWith(f)))
          hits.push(`${relative(ROOT, file)} -> ${relative(ROOT, mod)}`);
    expect(hits).toEqual([]);
  });

  it("the myco-state script reaches src/gate/ only through the stdin frame cap", () => {
    const reached = [...walk(join(ROOT, "scripts", "myco-state.ts")).keys()].filter((m) =>
      m.startsWith(`${join(ROOT, "src", "gate")}/`),
    );
    expect(reached.map((m) => relative(ROOT, m))).toEqual(["src/gate/stdio-frame.ts"]);
    expect(specifiers(readFileSync(join(ROOT, "src", "gate", "stdio-frame.ts"), "utf8"))).toEqual([
      "node:stream",
    ]);
  });
});

describe("the gate's request is unchanged by this track", () => {
  const h = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
  it("GATE_REQUEST_SCHEMA and ORACLE_INPUT_FIELDS are byte-identical to main before track I", () => {
    expect(h(GATE_REQUEST_SCHEMA)).toBe(
      "6086e47503d52dc79fcab2308ae0099f1a56c06df33e09fcefe62ac902605186",
    );
    // The xlsx gate PR (TIF-274 prerequisite, #550) adds three REJECTED field names (the
    // persisted format is the operator's, never the agent's); the request itself stays
    // taskId/runId/claim. Everything else is still byte-identical to main before track I.
    const XLSX_REJECTED = ["persistedFormat", "format", "fixtureXlsx"];
    for (const f of XLSX_REJECTED) expect(ORACLE_INPUT_FIELDS).toContain(f);
    expect(h(ORACLE_INPUT_FIELDS.filter((f) => !XLSX_REJECTED.includes(f)))).toBe(
      "7d4d98c51b5624bd915078b2924fafe8b3acee6449852716b97ff2ee959b8927",
    );
  });
});

describe("the gate decides the same with and without a state server", () => {
  it("same captured bytes, same result, whether or not myco-state was attached and called", async () => {
    const root = join(ROOT, "src", "gate", "families.ts");
    const tasks = buildTaskSet()
      .tasks.filter((t) => t.satisfiable)
      .slice(0, 4);
    const work = mkdtempSync(join(tmpdir(), "myco-state-gate-same-"));
    try {
      for (const task of tasks) {
        const reg = registerTask(task);
        if (!reg.ok) throw new Error(reg.reason);
        const persisted = new TextEncoder().encode(scriptedDocument(task));
        const results = [];
        for (const withState of [false, true]) {
          const dir = join(work, `${task.taskId}-${withState}`);
          mkdirSync(join(dir, "agent"), { recursive: true });
          const vault = new VerdictVault({
            root: join(dir, "vault"),
            key: newVaultKey(),
            agentRoots: [join(dir, "agent")],
          });
          let stateCalls = 0;
          const outcome = await runGatedTrial({
            vault,
            runId: "run-same",
            taskId: task.taskId,
            tasks: reg.registry,
            plan: capabilityArmPlan({
              arm: "screenshot-only",
              runId: "run-same",
              instruction: task.instruction,
              configDir: dir,
            }),
            oracleSources: [root],
            transport: {
              async runAgent() {
                if (!withState) return;
                const rows = new TextDecoder()
                  .decode(persisted)
                  .trimEnd()
                  .split("\n")
                  .map((l) => l.split(","));
                const state = createStateService({
                  backend: fakeBackend({ sheets: [{ name: "s", rows }], modified: true }),
                });
                for (const [tool, args] of [
                  ["state_list_sheets", {}],
                  ["state_read_range", { range: "A1:F5" }],
                  ["state_document_status", {}],
                ] as const) {
                  expect((await state.call(tool, args)).ok).toBe(true);
                  stateCalls += 1;
                }
              },
              async captureAfterStop() {
                return { "persisted/doc.csv": persisted };
              },
            },
          });
          if (outcome.status !== "decided") throw new Error("audit refused");
          expect(stateCalls).toBe(withState ? 3 : 0);
          results.push(outcome.result);
        }
        const strip = (r: unknown) =>
          JSON.parse(JSON.stringify(r), (k, v) => (/At$|Ms$|^decisionId$/.test(k) ? undefined : v));
        expect(strip(results[1]), task.taskId).toEqual(strip(results[0]));
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});

describe("the state core is self-contained", () => {
  const core = tsFiles(STATE).filter((f) => !f.endsWith(`${STATE}/arms.ts`));
  const allowedBuiltins = new Set([
    "node:child_process",
    "node:crypto",
    "node:fs", // only live-calc.ts (the harness's own session: profile dir, lock file)
    "node:os",
    "node:path",
    "node:readline",
    "node:stream",
    "node:url",
  ]);

  it("imports nothing outside src/state/ but node builtins", () => {
    const violations: string[] = [];
    for (const file of core)
      for (const [mod, specs] of walk(file)) {
        if (!mod.startsWith(`${STATE}/`))
          violations.push(`${relative(ROOT, mod)} from ${relative(ROOT, file)}`);
        for (const spec of specs)
          if (!spec.startsWith(".") && !allowedBuiltins.has(spec))
            violations.push(`${relative(ROOT, mod)} imports ${spec}`);
      }
    expect(violations).toEqual([]);
  });

  it("only the harness's live-session module touches the file system", () => {
    const withFs = core.filter((f) => /from\s+["']node:fs["']/.test(readFileSync(f, "utf8")));
    expect(withFs.map((f) => relative(STATE, f))).toEqual(["linux/live-calc.ts"]);
  });

  it("the walker catches a gate import (bite check)", () => {
    expect(specifiers('import { x } from "../gate/gate.ts";\nimport "node:fs";')).toEqual([
      "../gate/gate.ts",
      "node:fs",
    ]);
  });
});
