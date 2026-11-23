import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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
   * call) is EF-009; until then the boundary is the import graph.
   *
   * A token scan over specifiers is not enough: a re-export shim reaches the gate with no
   * forbidden token in the arm-facing file. So this walks the transitive import closure of
   * every arm-facing root and fails if any module in it is the gate.
   */
  const ARM_ROOTS = [
    join(SRC, "foundry", "baseline", "arms", "index.ts"),
    join(SRC, "foundry", "baseline", "todo-transport.ts"),
    join(SRC, "foundry", "baseline", "guest.ts"),
    join(SRC, "foundry", "baseline", "executor.ts"),
    join(SRC, "foundry", "baseline", "recorder.ts"),
  ];
  const GATE = join(SRC, "foundry", "grader", "attest.ts");

  /** Relative specifiers this file imports, resolved to absolute paths. */
  function importsOf(file: string): string[] {
    const source = readFileSync(file, "utf8");
    const specifiers = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]!);
    return specifiers
      .filter((spec) => spec.startsWith("."))
      .map((spec) => resolve(dirname(file), spec))
      .filter((path) => existsSync(path));
  }

  /** Every module reachable from `root`, following relative imports. */
  function closure(root: string): Set<string> {
    const seen = new Set<string>();
    const queue = [root];
    while (queue.length > 0) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      queue.push(...importsOf(file));
    }
    return seen;
  }

  it("no arm-facing root reaches the gate, directly or through a re-export", () => {
    const leaks = ARM_ROOTS.filter((root) => closure(root).has(GATE));
    expect(leaks).toEqual([]);
  });

  it("the closure check actually follows re-exports", () => {
    // Guard the guard: a shim that re-exports the gate must be detected, or the test above
    // proves only that the roots do not name the gate themselves.
    const shim = join(SRC, "foundry", "baseline", "__shim_probe.ts");
    writeFileSync(shim, 'export { attest } from "../grader/attest.ts";\n');
    try {
      expect(closure(shim).has(GATE)).toBe(true);
    } finally {
      rmSync(shim, { force: true });
    }
  });

  it("the gate lives in the grader, not in the arm harness", () => {
    expect(statSync(GATE).isFile()).toBe(true);
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
