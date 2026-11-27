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
      expect.arrayContaining([
        "evaluate.ts",
        "import.ts",
        "pins.ts",
        "prereg.ts",
        "r1-grade.ts",
        "requirements-report.ts",
      ]),
    );
  });

  it("its transitive imports stay inside src/benchmark/upstream/ (no gate, verifier, task generator or grade code)", () => {
    for (const f of upstreamFiles) expect(escapes(f), relative(ROOT, f)).toEqual([]);
  });

  it("no other src/ module reaches it: the gate never imports or trusts the upstream verdict", () => {
    expect(reachers(tsUnder(SRC))).toEqual([]);
  });

  it("neither the TS grader nor the Python driver names a gate module", () => {
    // `myco.gate/v1` is the public API name the pre-registration records, not a module path.
    const forbidden =
      /uno-verifier|filepersist|src\/gate|(?<!myco\.)gate\/|gate-hooks|myco_done_gate|core\/verify|src\/verify|tasks\/(intent|fixture)/;
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

/**
 * Public-benchmark R1 under the lead's 13:55Z harness ruling (gap item 6): the gate's oracle
 * must be independent of the upstream evaluator. No import of OSWorld's evaluator (its
 * `desktop_env` package: metrics, getters, DesktopEnv), no shared code with Myco's upstream
 * modules, no reading of evaluator output (`result.txt`, scores) or gold files. Checked for
 * the gate (src/gate) and the DONE gate hook (src/gate-hooks), and the other way round.
 */
describe("the gate and its OSWorld DONE hook are independent of the upstream evaluator, both ways", () => {
  const GATE_DIRS = [join(ROOT, "src", "gate"), join(ROOT, "src", "gate-hooks")];
  const UPSTREAM = join(ROOT, "src", "benchmark", "upstream");
  const filesUnder = (dir: string, ext: RegExp): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory()
        ? filesUnder(join(dir, e.name), ext)
        : ext.test(e.name)
          ? [join(dir, e.name)]
          : [],
    );
  const gateFiles = GATE_DIRS.flatMap((d) => filesUnder(d, /\.(ts|py)$/));
  const hookPy = filesUnder(join(ROOT, "src", "gate-hooks"), /\.py$/);
  const stripComments = (code: string) =>
    code.replace(/^\s*(\/\/|\*|\/\*\*|#).*$/gm, "").replace(/"""[\s\S]*?"""/g, "");
  /** Top-level Python imports, as module names. */
  const pyImports = (code: string) =>
    [...code.matchAll(/^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/gm)].map(
      (m) => (m[1] ?? m[2]) as string,
    );
  const PY_STDLIB_ALLOWED = new Set(["json", "re", "shlex", "subprocess", "time"]);
  /** Anything that names the upstream evaluator, its outputs, its gold files or Myco's upstream modules. */
  const EVALUATOR =
    /desktop_env|evaluators|\bmetrics\b|\bgetters\b|result\.txt|cloud_file|run_upstream_metric|benchmark\/upstream|r1-grade|evaluate\.ts|upstream-metric-mock|osworld-desktopenv-evaluate/;
  const problemsIn = (file: string) => {
    const code = stripComments(readFileSync(file, "utf8"));
    const out: string[] = [];
    if (file.endsWith(".py"))
      for (const mod of pyImports(code))
        if (!PY_STDLIB_ALLOWED.has(mod)) out.push(`${relative(ROOT, file)} imports ${mod}`);
    const hit = code.match(EVALUATOR);
    if (hit) out.push(`${relative(ROOT, file)} names ${hit[0]}`);
    return out;
  };

  it("has the gate and the hook to check", () => {
    expect(hookPy.map((f) => relative(ROOT, f))).toEqual([
      "src/gate-hooks/osworld/myco_done_gate.py",
    ]);
    expect(gateFiles.length).toBeGreaterThan(20);
  });

  it("no gate or hook file imports or names the upstream evaluator, its output or gold files; the hook imports only json, re, shlex, subprocess and time", () => {
    expect(gateFiles.flatMap(problemsIn)).toEqual([]);
  });

  /**
   * N3 (lead ruling 15:26Z): the self-check arm reads nothing but the instruction and the guest
   * home directory through the controller's run_bash_script. The hook's code (comments and
   * docstrings stripped, the probe text included) names no environment, evaluator, task
   * configuration, gold, fixture, oracle or score-file access, and calls no controller method
   * but run_bash_script. The runtime half is test/benchmark/osworld-gate-hook.test.ts.
   */
  const SELF_CHECK_FORBIDDEN =
    /\.env\b|\bevaluat|get_file|setup_controller|cache_dir|task_config|\bexample\b|\bgold\b|expected|fixture|oracle|result\.txt|evaluation_examples|\bopen\(|os\.|glob|urllib|requests|socket/;
  const selfCheckProblems = (file: string) => {
    const raw = readFileSync(file, "utf8");
    const probe = raw.match(/SELF_CHECK_PROBE = r"""([\s\S]*?)"""/)?.[1] ?? "";
    const code = `${stripComments(raw)}\n${probe}`;
    const out: string[] = [];
    const hit = code.match(SELF_CHECK_FORBIDDEN);
    if (hit) out.push(`${relative(ROOT, file)} names ${hit[0]}`);
    for (const m of code.matchAll(/controller\(\)\.(\w+)/g))
      if (m[1] !== "run_bash_script")
        out.push(`${relative(ROOT, file)} calls controller().${m[1]}`);
    if (!/self\.controller\(\)\.run_bash_script\(/.test(code)) out.push("no run_bash_script call");
    if (!probe) out.push("no probe");
    return out;
  };

  it("N3: the self-check names no environment, evaluator, task config, gold, fixture, oracle or score file, and calls only run_bash_script on the controller", () => {
    expect(hookPy.flatMap(selfCheckProblems)).toEqual([]);
  });

  it("N3: the self-check checks bite: a planted gold read, evaluator call and other controller call are reported", () => {
    const dir = mkdtempSync(join(tmpdir(), "self-check-bite-"));
    try {
      const base = readFileSync(hookPy[0] as string, "utf8");
      const plant = (from: string, to: string) => {
        const f = join(dir, `p${Math.random().toString(36).slice(2)}.py`);
        expect(base).toContain(from);
        writeFileSync(f, base.replace(from, to));
        return selfCheckProblems(f);
      };
      const call = "            result = self.controller().run_bash_script(";
      expect(plant(call, `            open(self.task_id + "/gold.xlsx").close()\n${call}`)).toEqual(
        [expect.stringMatching(/ names (open\(|gold)$/)],
      );
      expect(plant(call, `            self.agent.env.evaluate()\n${call}`)).toEqual([
        expect.stringContaining("names .env"),
      ]);
      expect(
        plant(call, `            self.controller().get_file("/home/user/x")\n${call}`),
      ).toEqual(expect.arrayContaining([expect.stringContaining("calls controller().get_file")]));
      expect(plant("printf 'END\\n'", "cat ~/../../tmp/result.txt\nprintf 'END\\n'")).toEqual([
        expect.stringContaining("names result.txt"),
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("nothing under src/benchmark/upstream names the gate, the hook or its module", () => {
    const forbidden = /src\/gate|gate-hooks|myco_done_gate|DoneGate|myco_gate_check/;
    for (const f of filesUnder(UPSTREAM, /\.(ts|py)$/)) {
      const code = stripComments(readFileSync(f, "utf8"));
      expect(code, relative(ROOT, f)).not.toMatch(forbidden);
    }
  });

  it("the checks bite: a planted evaluator import, a planted result.txt read and a planted hook import are reported", () => {
    const dir = mkdtempSync(join(tmpdir(), "gate-hook-bite-"));
    try {
      const py = join(dir, "planted.py");
      writeFileSync(py, "import json\nfrom desktop_env.evaluators import metrics\n");
      expect(problemsIn(py)).toEqual(
        expect.arrayContaining([expect.stringContaining("imports desktop_env.evaluators")]),
      );
      const reader = join(dir, "reader.ts");
      writeFileSync(reader, 'const score = readFileSync(join(dir, "result.txt"), "utf8");\n');
      expect(problemsIn(reader)).toEqual([expect.stringContaining("names result.txt")]);
      const os = join(dir, "os_import.py");
      writeFileSync(os, "import os\n");
      expect(problemsIn(os)).toEqual([expect.stringContaining("imports os")]);
      expect("import myco_done_gate").toMatch(/src\/gate|gate-hooks|myco_done_gate/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
