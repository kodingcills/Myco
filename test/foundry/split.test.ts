import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TODO_TASKS } from "../../src/foundry/tasks/bank.ts";
import { TODO_FIXTURE_SPECS, TODO_FIXTURES } from "../../src/foundry/tasks/todo.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const SRC = join(ROOT, "src");
const GRADER_ROOTS = ["oracles", "hidden", "hidden-split", "grader"].map((name) =>
  join(SRC, "foundry", name),
);
const graderImport =
  /(?:from\s*|(?:import|require)\s*(?:\(\s*)?)["'][^"']*(?:oracles|hidden|hidden-split|grader)\//;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(path);
  }
  return out;
}

describe("EF-002 hidden split isolation", () => {
  it("no src/ file outside the hidden roots imports them", () => {
    const leaks = sourceFiles(SRC)
      .filter((file) => !GRADER_ROOTS.some((root) => file.startsWith(`${root}/`)))
      .filter((file) => graderImport.test(readFileSync(file, "utf8")));
    expect(leaks).toEqual([]);
  });

  it("detects direct imports, re-exports and side-effect imports of grader code", () => {
    expect('import { scoreTrial } from "../../oracles/blind.ts"').toMatch(graderImport);
    expect('import("../../hidden-split/index.ts")').toMatch(graderImport);
    expect('import "../oracles/state.ts"').toMatch(graderImport);
    expect('export { runArm } from "../grader/baseline-runner.ts"').toMatch(graderImport);
  });

  it("the public task bank does not import the oracle", () => {
    for (const name of [
      "tasks/bank.ts",
      "tasks/todo.ts",
      "tasks/app-model.ts",
      "screen.ts",
      "guard.ts",
      "types.ts",
    ]) {
      const file = join(SRC, "foundry", name);
      expect(statSync(file).isFile(), `${name} must exist`).toBe(true);
      // Comments may name the roots; an import statement may not.
      expect(readFileSync(file, "utf8"), name).not.toMatch(/from\s+["'][^"']*(oracles|hidden)\//);
    }
  });

  it("no public file contains a derived answer for a task", () => {
    // The expected end states are whatever `expected()` derives. A literal copy of one of
    // them in a public file is the leak the two-root split exists to prevent.
    const publicText = ["tasks/bank.ts", "tasks/todo.ts", "types.ts"]
      .map((name) => readFileSync(join(SRC, "foundry", name), "utf8"))
      .join("\n");
    for (const task of TODO_TASKS) {
      expect(publicText, task.taskId).not.toContain("expectedEndState");
    }
    for (const spec of TODO_FIXTURE_SPECS) {
      expect(publicText, spec.fixtureId).not.toMatch(
        new RegExp(`${spec.fixtureId}[\\s\\S]{0,400}answer`),
      );
    }
  });
});

describe("TIF-95: the attestation gate is not reachable from arm code", () => {
  /**
   * The cheap half of process isolation. Full isolation (a separate process the arm cannot
   * call) is a follow-up; until then the boundary is enforced by import graph, so an arm
   * cannot import the gate and satisfy it with its own provenance.
   */
  const ARM_FACING = [
    join(SRC, "foundry", "baseline", "arms", "index.ts"),
    join(SRC, "foundry", "baseline", "todo-transport.ts"),
    join(SRC, "foundry", "baseline", "guest.ts"),
    join(SRC, "foundry", "baseline", "executor.ts"),
    join(SRC, "foundry", "baseline", "recorder.ts"),
  ];

  it("no arm-facing file imports the attestation gate", () => {
    const leaks = ARM_FACING.filter((file) => {
      if (!statSync(file).isFile()) return false;
      const source = readFileSync(file, "utf8");
      // Static import, dynamic import, and require all count: a boundary that only catches
      // `from "..."` is a boundary an arm can step around with `await import(...)`.
      return (
        /from\s+["'][^"']*grader\/attest/.test(source) ||
        /import\s*\(\s*["'][^"']*grader\/attest/.test(source) ||
        /require\s*\(\s*["'][^"']*grader\/attest/.test(source)
      );
    });
    expect(leaks).toEqual([]);
  });

  it("the gate lives in the grader, not in the arm harness", () => {
    expect(statSync(join(SRC, "foundry", "grader", "attest.ts")).isFile()).toBe(true);
    expect(existsSync(join(SRC, "foundry", "baseline", "attest.ts"))).toBe(false);
  });
});

describe("EF-001 fixture/defect drift", () => {
  it("each manifest's defect matches its spec", () => {
    for (const manifest of TODO_FIXTURES) {
      const spec = TODO_FIXTURE_SPECS.find(
        (candidate) => candidate.fixtureId === manifest.fixtureId,
      );
      expect(spec, manifest.fixtureId).toBeDefined();
      expect(manifest.defect).toBe(spec!.defect);
      expect(manifest.version).toBeGreaterThan(0);
    }
  });

  it("every fixture declares at least one trap string and one forbidden shortcut", () => {
    for (const manifest of TODO_FIXTURES) {
      expect(manifest.screenClaimsToTrap.length, manifest.fixtureId).toBeGreaterThan(0);
      expect(manifest.mustNotBeSolvableBy.length, manifest.fixtureId).toBeGreaterThan(0);
    }
  });

  it("every task points at a fixture that exists", () => {
    const ids = new Set(TODO_FIXTURES.map((manifest) => manifest.fixtureId));
    for (const task of TODO_TASKS) expect(ids.has(task.fixtureId), task.taskId).toBe(true);
  });

  it("tasks and fixtures are one-to-one (no fixture is unused, no task is unfixtured)", () => {
    const used = new Set(TODO_TASKS.map((task) => task.fixtureId));
    expect(used.size).toBe(TODO_TASKS.length);
    expect(TODO_FIXTURES.length).toBe(TODO_TASKS.length);
  });
});
