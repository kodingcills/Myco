/**
 * TIF-267 independence guard: the benchmark grader must not share code with the gating
 * oracle (M2 plan §4: "if it shares code or inputs with the gating oracle, R1 grades
 * itself"). Walks the transitive relative-import graph of every grader module and fails
 * if it leaves `src/benchmark/grade/`, or reaches a process launcher (the gate's persisted
 * check runs `soffice`).
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..", "..");
const GRADER = join(ROOT, "src", "benchmark", "grade");
const ALLOWED_BUILTINS = new Set(["node:crypto", "node:zlib"]);

const IMPORT =
  /(?:import|export)\s[^;]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|require\s*\(\s*["']([^"']+)["']\s*\)|import\s+["']([^"']+)["']/g;

function specifiers(source: string): string[] {
  return [...source.matchAll(IMPORT)].map((m) => (m[1] ?? m[2] ?? m[3] ?? m[4]) as string);
}

function walk(entry: string, seen = new Map<string, string[]>()): Map<string, string[]> {
  if (seen.has(entry)) return seen;
  const specs = specifiers(readFileSync(entry, "utf8"));
  seen.set(entry, specs);
  for (const spec of specs) {
    if (spec.startsWith(".")) walk(resolve(dirname(entry), spec), seen);
  }
  return seen;
}

const graderFiles = readdirSync(GRADER)
  .filter((f) => f.endsWith(".ts"))
  .map((f) => join(GRADER, f));

describe("benchmark grader independence (TIF-267)", () => {
  it("has modules to check", () => {
    expect(graderFiles.length).toBeGreaterThanOrEqual(4);
  });

  it("imports nothing outside src/benchmark/grade/ except allowed node builtins", () => {
    const violations: string[] = [];
    for (const file of graderFiles) {
      for (const [mod, specs] of walk(file)) {
        if (!mod.startsWith(`${GRADER}/`))
          violations.push(`${relative(ROOT, mod)} reached from ${relative(ROOT, file)}`);
        for (const spec of specs) {
          if (!spec.startsWith(".") && !ALLOWED_BUILTINS.has(spec)) {
            violations.push(`${relative(ROOT, mod)} imports ${spec}`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("never names a gate module or a process launcher", () => {
    // `state/` and `myco-state`: capability track I's live-state tools (src/state/) are an
    // agent aid, never a grading input.
    const forbidden =
      /uno-verifier|filepersist|tasks\/(intent|fixture|calc-record-edit)|core\/verify|child_process|soffice|execFile|spawn\(|state\/|myco-state/;
    for (const file of graderFiles) {
      const code = readFileSync(file, "utf8").replace(/^\s*(\/\/|\*|\/\*\*).*$/gm, "");
      expect(code, relative(ROOT, file)).not.toMatch(forbidden);
    }
  });

  it("cross-app (track P): the grader has its own readers for the new format, sharing nothing with the gate", () => {
    // The cross-app grader and its plain-text report reader are walked like every grader
    // module above; this pins that they exist and name no gate or task-definition module.
    for (const name of ["cross-app.ts", "report-text.ts"]) {
      const file = join(GRADER, name);
      expect(graderFiles).toContain(file);
      const code = readFileSync(file, "utf8").replace(/^\s*(\/\/|\*|\/\*\*).*$/gm, "");
      expect(code, name).not.toMatch(/from\s+["'][^"']*(gate\/|tasks\/|oracle-selftest\/)/);
    }
  });

  it("cross-app (track P): the gate's cross-app family never reaches the grader", () => {
    const gateFiles = ["cross-app.ts", "cross-app-demo.ts", "families.ts", "gate.ts"].map((f) =>
      join(ROOT, "src", "gate", f),
    );
    const reached: string[] = [];
    for (const file of gateFiles)
      for (const mod of walk(file).keys())
        if (mod.startsWith(join(ROOT, "src", "benchmark"))) reached.push(relative(ROOT, mod));
    expect(reached).toEqual([]);
  });

  it("the walker catches a gate import (bite check)", () => {
    const fake =
      'import { x } from "../../verify/uno-verifier.ts";\nexport * from "../../core/filepersist.ts";\nimport "child_process";';
    expect(specifiers(fake)).toEqual([
      "../../verify/uno-verifier.ts",
      "../../core/filepersist.ts",
      "child_process",
    ]);
  });
});

describe("the corrections A/B analysis never reaches gate-side code (#547 D7; O1 follow-up)", () => {
  const AB = join(ROOT, "src", "m2", "corrections-ab.ts");
  const BENCH = join(ROOT, "src", "benchmark");
  /** The A/B module and the shared binding path it imports (R1's check binds through it too). */
  const ENTRIES = [
    AB,
    join(BENCH, "check.ts"),
    join(BENCH, "taskset-binding.ts"),
    join(BENCH, "published-tasks.ts"),
  ];
  const GATE = join(ROOT, "src", "gate");
  const VERIFY = join(ROOT, "src", "verify");
  /** The task generators the gate also imports (O1), and the module that runs them. */
  const TASKS_DIR = join(ROOT, "src", "tasks");
  const GENERATOR = join(BENCH, "taskset.ts");
  /** The guard itself: every module the walk reaches that is gate-side. */
  const gateSide = (entry: string) =>
    [...walk(entry).keys()]
      .filter(
        (m) =>
          m.startsWith(`${GATE}/`) ||
          m.startsWith(`${VERIFY}/`) ||
          m.startsWith(`${TASKS_DIR}/`) ||
          m === GENERATOR,
      )
      .map((m) => relative(ROOT, m));
  /** Every child_process import the walk reaches. */
  const launchers = (entry: string) =>
    [...walk(entry)].flatMap(([mod, specs]) =>
      specs
        .filter((s) => /child_process/.test(s))
        .map((s) => `${relative(ROOT, mod)} imports ${s}`),
    );

  it("its transitive imports stay out of src/gate/, src/verify/, src/tasks/ and the task generator, and launch no process", () => {
    expect([...walk(AB).keys()]).toEqual(
      expect.arrayContaining([
        join(GRADER, "row.ts"),
        join(BENCH, "taskset-binding.ts"),
        join(BENCH, "published-tasks.ts"),
      ]),
    );
    for (const entry of ENTRIES) {
      expect(gateSide(entry), relative(ROOT, entry)).toEqual([]);
      expect(launchers(entry), relative(ROOT, entry)).toEqual([]);
    }
  });

  it("the check bites: the same walk and predicates report each planted gate-side or launcher import (#547 R2-D6)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ab-bite-"));
    try {
      const planted = join(dir, "planted.ts");
      const rel = (p: string) => relative(dir, p).split(sep).join("/");
      writeFileSync(
        planted,
        `import { x } from "${rel(join(GRADER, "row.ts"))}";\n` +
          `import "${rel(join(GATE, "corrections.ts"))}";\n` +
          `import "${rel(join(VERIFY, "uno-verifier.ts"))}";\n` +
          `import type { T } from "${rel(join(TASKS_DIR, "intent.ts"))}";\n` +
          `import { buildTaskSet } from "${rel(GENERATOR)}";\n` +
          `import "node:child_process";\nexport { x, buildTaskSet };\nexport type { T };\n`,
      );
      expect(gateSide(planted)).toEqual(
        expect.arrayContaining([
          "src/gate/corrections.ts",
          "src/verify/uno-verifier.ts",
          "src/tasks/intent.ts",
          "src/tasks/fixture.ts",
          "src/benchmark/taskset.ts",
        ]),
      );
      expect(launchers(planted)).toContain(`${relative(ROOT, planted)} imports node:child_process`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Capability track T (bring your own app): third-party plugins (`src/plugins/`, the example
 * plugins under `examples/plugins/`) never share code with the grader, in either direction.
 * A plugin oracle is a gate-side oracle as far as R1 is concerned: if it shared code with the
 * grader, the grader would grade the plugin with the plugin.
 */
describe("plugins never share code with the benchmark grader (track T)", () => {
  const PLUGIN_ROOTS = [join(ROOT, "src", "plugins"), join(ROOT, "examples", "plugins")];
  const pluginFiles = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory()
        ? pluginFiles(join(dir, e.name))
        : /\.(ts|mjs|js)$/.test(e.name)
          ? [join(dir, e.name)]
          : [],
    );
  const files = PLUGIN_ROOTS.flatMap(pluginFiles);

  it("has plugin modules to check", () => {
    expect(files.length).toBeGreaterThanOrEqual(6);
  });

  it("no plugin module reaches src/benchmark/grade/ (transitively)", () => {
    const violations: string[] = [];
    for (const file of files)
      for (const mod of walk(file).keys())
        if (mod.startsWith(`${GRADER}/`))
          violations.push(`${relative(ROOT, mod)} reached from ${relative(ROOT, file)}`);
    expect(violations).toEqual([]);
  });

  it("no grader module reaches a plugin module (transitively)", () => {
    for (const file of graderFiles)
      for (const mod of walk(file).keys())
        for (const root of PLUGIN_ROOTS) expect(mod.startsWith(`${root}/`), mod).toBe(false);
  });

  it("no plugin module names the grader", () => {
    for (const file of files)
      expect(readFileSync(file, "utf8"), relative(ROOT, file)).not.toMatch(/benchmark\/grade/);
  });
});
