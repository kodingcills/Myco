/**
 * TIF-267 independence guard: the benchmark grader must not share code with the gating
 * oracle (M2 plan §4: "if it shares code or inputs with the gating oracle, R1 grades
 * itself"). Walks the transitive relative-import graph of every grader module and fails
 * if it leaves `src/benchmark/grade/`, or reaches a process launcher (the gate's persisted
 * check runs `soffice`).
 */
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
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
      /uno-verifier|filepersist|tasks\/(intent|fixture|calc-record-edit|calc-xlsxgen)|core\/verify|gate\/|xlsx-document|child_process|soffice|execFile|spawn\(|state\/|myco-state/;
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

  it("ledger-csv/1 (track T, #617): the ledger grader is walked like every grader module and names no plugin code", () => {
    const file = join(GRADER, "ledger.ts");
    expect(graderFiles).toContain(file);
    const code = readFileSync(file, "utf8").replace(/^\s*(\/\/|\*|\/\*\*).*$/gm, "");
    expect(code).not.toMatch(/plugins\/|csv-ledger|oracle-selftest\//);
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

/**
 * Public benchmarks (#682): the upstream-evaluator grader under src/benchmark/upstream/ is
 * ground truth for osworld-office-v1 and waa-office-v1. It never reaches gate-side code, and no
 * other src/ module (the gate, the verifier, the pilot) reaches it. It may launch a process:
 * that process is the upstream evaluator itself, run under `python3 -I` with no host env.
 */
describe("the upstream-evaluator grader is independent of the gate, both ways (#682)", () => {
  const UPSTREAM = join(ROOT, "src", "benchmark", "upstream");
  const SRC = join(ROOT, "src");
  const ALLOWED = new Set(["node:crypto", "node:child_process", "node:fs", "node:os", "node:path"]);
  const tsUnder = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory()
        ? tsUnder(join(dir, e.name))
        : e.name.endsWith(".ts")
          ? [join(dir, e.name)]
          : [],
    );
  const upstreamFiles = tsUnder(UPSTREAM);
  /** Every module an entry reaches outside src/benchmark/upstream, and every disallowed builtin. */
  const escapes = (entry: string) =>
    [...walk(entry)].flatMap(([mod, specs]) => [
      ...(mod.startsWith(`${UPSTREAM}/`) ? [] : [`${relative(ROOT, mod)} reached`]),
      ...specs
        .filter((s) => !s.startsWith(".") && !ALLOWED.has(s))
        .map((s) => `${relative(ROOT, mod)} imports ${s}`),
    ]);
  /**
   * Like `walk`, but resolves `./x.js` specifiers to `./x.ts` (some src/ modules use the NodeNext
   * spelling) and records an unresolvable relative import instead of throwing.
   */
  const walkSrc = (entry: string, seen = new Set<string>()): Set<string> => {
    if (seen.has(entry)) return seen;
    seen.add(entry);
    for (const spec of specifiers(readFileSync(entry, "utf8"))) {
      if (!spec.startsWith(".")) continue;
      const target = resolve(dirname(entry), spec);
      const candidates = [target, target.replace(/\.js$/, ".ts"), `${target}.ts`];
      const hit = candidates.find((c) => existsSync(c) && statSync(c).isFile());
      if (hit) walkSrc(hit, seen);
      else seen.add(`UNRESOLVED:${target}`);
    }
    return seen;
  };
  /** Every src/ module outside src/benchmark/upstream that reaches it. */
  const reachers = (files: string[]) =>
    files
      .filter((f) => !f.startsWith(`${UPSTREAM}/`))
      .filter((f) =>
        [...walkSrc(f)].some((m) => m.replace(/^UNRESOLVED:/, "").startsWith(UPSTREAM)),
      )
      .map((f) => relative(ROOT, f));

  it("has the grader modules to check", () => {
    expect(upstreamFiles.map((f) => relative(UPSTREAM, f)).sort()).toEqual(
      expect.arrayContaining(["evaluate.ts", "import.ts", "pins.ts", "placement-report.ts"]),
    );
  });

  it("its transitive imports stay inside src/benchmark/upstream/ (no gate, verifier, task generator or grade code)", () => {
    for (const f of upstreamFiles) expect(escapes(f), relative(ROOT, f)).toEqual([]);
  });

  it("no other src/ module reaches it: the gate never imports or trusts the upstream verdict", () => {
    expect(reachers(tsUnder(SRC))).toEqual([]);
  });

  it("neither the TS grader nor the Python driver names a gate module", () => {
    const forbidden =
      /uno-verifier|filepersist|src\/gate|gate\/|core\/verify|src\/verify|tasks\/(intent|fixture)/;
    for (const name of [...upstreamFiles, join(UPSTREAM, "run_upstream_metric.py")]) {
      const code = readFileSync(name, "utf8").replace(/^\s*(\/\/|\*|\/\*\*|#).*$/gm, "");
      expect(code, relative(ROOT, name)).not.toMatch(forbidden);
    }
  });

  it("the checks bite: a planted gate import and a planted reacher are both reported", () => {
    const dir = mkdtempSync(join(tmpdir(), "upstream-bite-"));
    try {
      const rel = (from: string, p: string) => relative(dirname(from), p).split(sep).join("/");
      const gateSideReacher = join(dir, "reacher.ts");
      writeFileSync(
        gateSideReacher,
        `import "${rel(gateSideReacher, join(UPSTREAM, "evaluate.ts"))}";\n`,
      );
      expect(reachers([gateSideReacher])).toEqual([relative(ROOT, gateSideReacher)]);
      const planted = join(dir, "planted.ts");
      writeFileSync(
        planted,
        `import "${rel(planted, join(ROOT, "src", "gate", "gate.ts"))}";\nimport "node:net";\n`,
      );
      const found = escapes(planted);
      expect(found).toEqual(
        expect.arrayContaining([expect.stringContaining("src/gate/gate.ts reached")]),
      );
      expect(found).toEqual(expect.arrayContaining([expect.stringContaining("imports node:net")]));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
