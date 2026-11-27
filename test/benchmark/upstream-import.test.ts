/**
 * #682 items 2-3 on a synthetic upstream checkout (no network, standard-library Python only):
 * the importer keeps ids and instructions verbatim, pins every task and evaluator file by
 * SHA-256, applies the stated selection rule and classifies placement; the evaluator wrapper
 * runs the upstream metric unmodified, follows upstream's combination and FAIL-action rules,
 * and fails closed (ungradable, codes only) on any byte that moved. Verdicts here are MOCK.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { gradeUpstreamTask, type UpstreamEndState } from "../../src/benchmark/upstream/evaluate.ts";
import {
  ImportError,
  importSubset,
  OSWORLD_OFFICE_V1,
  type UpstreamReader,
} from "../../src/benchmark/upstream/import.ts";
import { SYN_TASKS, sha, synPin, writeSyntheticUpstream } from "./upstream-fixture.ts";

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function reader(root: string): UpstreamReader {
  return {
    readFile: (rel) => readFileSync(join(root, rel)),
    listDir: (rel) => readdirSync(join(root, rel)),
    exists: (rel) => existsSync(join(root, rel)) && statSync(join(root, rel)).isFile(),
  };
}

function fresh(tasks = SYN_TASKS) {
  const root = writeSyntheticUpstream(tasks);
  roots.push(root);
  return { root, ...importSubset(reader(root), OSWORLD_OFFICE_V1, synPin()) };
}

const hasPython = spawnSync("python3", ["--version"]).status === 0;

describe("upstream importer (#682 item 2)", () => {
  it("keeps upstream ids and instructions verbatim and pins each task file's raw bytes", () => {
    const { root, tasks } = fresh();
    for (const t of tasks) {
      const raw = readFileSync(join(root, t.taskFile));
      const upstream = JSON.parse(raw.toString("utf8"));
      expect(t.taskId).toBe(upstream.id);
      expect(t.instruction).toBe(upstream.instruction);
      expect(t.taskFileSha256).toBe(sha(raw));
    }
    expect(tasks.find((t) => t.taskId === "calc-0001")?.instruction).toBe(
      "Type HELLO into the file.  Keep  the spacing.",
    );
  });

  it("selects by the stated rule only: every listed task in the three LibreOffice domains, nothing from multi_apps", () => {
    const { tasks, manifest } = fresh();
    expect(tasks.map((t) => t.taskId)).toEqual([
      "calc-0001",
      "calc-0002",
      "writer-0001",
      "impress-0001",
    ]);
    expect(manifest.counts).toEqual({
      total: 4,
      perDomain: { libreoffice_calc: 2, libreoffice_writer: 1, libreoffice_impress: 1 },
      infeasible: 1,
      excluded: 0,
    });
    expect(manifest.environment).toBe("osworld-desktopenv");
    expect(manifest.exclusions).toEqual({});
    expect(manifest.selectionRule).toBe(OSWORLD_OFFICE_V1.selectionRule);
    expect(OSWORLD_OFFICE_V1.domains).toEqual([
      "libreoffice_calc",
      "libreoffice_writer",
      "libreoffice_impress",
    ]);
  });

  it("needing another app, a guest-state getter or the network is never an exclusion (no Myco placement filter)", () => {
    const extra = {
      domain: "libreoffice_writer",
      id: "writer-0002",
      body: {
        instruction: "Writer and Chrome, over the network.",
        related_apps: ["libreoffice writer", "chrome", "gimp"],
        proxy: true,
        evaluator: {
          func: "same_text",
          result: { type: "accessibility_tree" },
          expected: { type: "vm_command_line", command: "ls" },
        },
      },
    };
    const { tasks } = fresh([...SYN_TASKS, extra]);
    expect(tasks.map((t) => t.taskId)).toContain("writer-0002");
    expect(tasks.map((t) => t.taskId)).toContain("impress-0001");
    expect(tasks.find((t) => t.taskId === "writer-0002")?.requirements).toEqual({
      environment: "osworld-desktopenv",
      getters: ["accessibility_tree", "vm_command_line"],
      setup: [],
      postconfig: [],
      needs: ["GETTERS_SERVED_BY_UPSTREAM_CONTROLLER", "NETWORK_PROXY"],
    });
  });

  it("drops a listed task only through the stated exclusion list, and refuses an exclusion upstream does not list", () => {
    const root = writeSyntheticUpstream();
    roots.push(root);
    const spec = { ...OSWORLD_OFFICE_V1, exclusions: { "calc-0002": "ASSET_LICENSE_REFUSED" } };
    const { tasks, manifest } = importSubset(reader(root), spec, synPin());
    expect(tasks.map((t) => t.taskId)).not.toContain("calc-0002");
    expect(manifest.counts).toMatchObject({ total: 3, excluded: 1, infeasible: 0 });
    expect(manifest.exclusions).toEqual({ "calc-0002": "ASSET_LICENSE_REFUSED" });
    expect(() =>
      importSubset(
        reader(root),
        { ...OSWORLD_OFFICE_V1, exclusions: { "not-listed": "X" } },
        synPin(),
      ),
    ).toThrow(/EXCLUSION_NOT_LISTED not-listed/);
  });

  it("pins every evaluator file a task needs, including in-package imports, and nothing else", () => {
    const { root, tasks, manifest } = fresh();
    const dir = "desktop_env/evaluators/metrics";
    expect(Object.keys(manifest.evaluatorFiles)).toEqual([`${dir}/helpers.py`, `${dir}/text.py`]);
    for (const [f, digest] of Object.entries(manifest.evaluatorFiles))
      expect(digest).toBe(sha(readFileSync(join(root, f))));
    const writer = tasks.find((t) => t.taskId === "writer-0001");
    expect(writer?.evaluator.modules).toEqual(["text", "text"]);
    expect(tasks.find((t) => t.taskId === "calc-0002")?.evaluator).toMatchObject({
      funcs: ["infeasible"],
      modules: [""],
      files: [],
    });
  });

  it("records assets by URL with license unclear and never fetches them", () => {
    const { tasks } = fresh();
    expect(tasks.find((t) => t.taskId === "calc-0001")?.assets).toEqual([
      { role: "config", url: "https://example.invalid/seed.xlsx", license: "unclear" },
      { role: "expected", url: "https://example.invalid/gold.txt", license: "unclear" },
    ]);
  });

  it("records what each task needs from OSWorld's own harness, as codes", () => {
    const { tasks } = fresh();
    const r = Object.fromEntries(tasks.map((t) => [t.taskId, t.requirements]));
    expect(r["calc-0001"]).toEqual({
      environment: "osworld-desktopenv",
      getters: ["cloud_file", "vm_file"],
      setup: ["download"],
      postconfig: ["sleep"],
      needs: [
        "GETTERS_SERVED_BY_UPSTREAM_CONTROLLER",
        "GOLD_ASSETS_LICENSE_UNCLEAR",
        "POSTCONFIG_RUN_BY_UPSTREAM_EVALUATE",
        "SEED_ASSETS_LICENSE_UNCLEAR",
      ],
    });
    expect(r["calc-0002"]?.needs).toEqual(["INFEASIBLE_TASK_GRADED_ON_AGENT_FAIL_ACTION"]);
    expect(r["impress-0001"]).toMatchObject({
      getters: ["cloud_file", "vm_command_line"],
      needs: ["GETTERS_SERVED_BY_UPSTREAM_CONTROLLER", "GOLD_ASSETS_LICENSE_UNCLEAR"],
    });
    expect(r["writer-0001"]?.getters).toEqual(["cloud_file", "rule", "vm_file"]);
  });

  it("refuses a changed license, a missing task file, an unknown evaluator function and a mismatched id", () => {
    const root = writeSyntheticUpstream();
    roots.push(root);
    const r = reader(root);
    expect(() =>
      importSubset(r, OSWORLD_OFFICE_V1, { ...synPin(), licenseSha256: "0".repeat(64) }),
    ).toThrow(/LICENSE_CHANGED/);
    const bad = (tasks: typeof SYN_TASKS) => {
      const rt = writeSyntheticUpstream(tasks);
      roots.push(rt);
      return () => importSubset(reader(rt), OSWORLD_OFFICE_V1, synPin());
    };
    const t0 = SYN_TASKS[0] as (typeof SYN_TASKS)[number];
    expect(bad([{ ...t0, body: { ...t0.body, evaluator: { func: "nope", result: {} } } }])).toThrow(
      /EVALUATOR_FUNC_NOT_FOUND nope/,
    );
    const missing = writeSyntheticUpstream();
    roots.push(missing);
    rmSync(join(missing, "evaluation_examples/examples/libreoffice_calc/calc-0001.json"));
    expect(() => importSubset(reader(missing), OSWORLD_OFFICE_V1, synPin())).toThrow(
      /TASK_FILE_MISSING/,
    );
    const wrongId = writeSyntheticUpstream();
    roots.push(wrongId);
    const f = join(wrongId, "evaluation_examples/examples/libreoffice_calc/calc-0001.json");
    writeFileSync(f, readFileSync(f, "utf8").replace('"id": "calc-0001"', '"id": "calc-9999"'));
    expect(() => importSubset(reader(wrongId), OSWORLD_OFFICE_V1, synPin())).toThrow(ImportError);
  });

  it("is deterministic: the same checkout gives byte-identical output", () => {
    const a = fresh();
    const b = fresh();
    expect(a.tasksJsonl).toBe(b.tasksJsonl);
    expect(a.manifest.tasksSha256).toBe(sha(a.tasksJsonl));
  });
});

describe.runIf(hasPython)(
  "upstream evaluator wrapper on synthetic metrics (#682 item 3, MOCK)",
  () => {
    const setup = () => {
      const f = fresh();
      const task = (id: string) => {
        const t = f.tasks.find((x) => x.taskId === id);
        if (!t) throw new Error(id);
        return t;
      };
      const file = (name: string, text: string) => {
        const p = join(f.root, name);
        writeFileSync(p, text);
        return p;
      };
      return { ...f, task, file };
    };
    const mock = (over: Partial<UpstreamEndState>): UpstreamEndState => ({
      label: "MOCK",
      results: [],
      expected: [],
      lastAction: null,
      ...over,
    });

    it("returns the upstream metric's verdict: pass on a matching end state, fail on a broken one", () => {
      const s = setup();
      const gold = s.file("gold.txt", "HELLO");
      const good = gradeUpstreamTask({
        root: s.root,
        manifest: s.manifest,
        task: s.task("calc-0001"),
        endState: mock({ results: [s.file("ok.txt", "HELLO")], expected: [gold] }),
      });
      expect(good).toMatchObject({ status: "pass", upstreamScore: 1, label: "MOCK" });
      const bad = gradeUpstreamTask({
        root: s.root,
        manifest: s.manifest,
        task: s.task("calc-0001"),
        endState: mock({ results: [s.file("bad.txt", "HELL0")], expected: [gold] }),
      });
      expect(bad).toMatchObject({ status: "fail", upstreamScore: 0 });
      const notCaptured = gradeUpstreamTask({
        root: s.root,
        manifest: s.manifest,
        task: s.task("calc-0001"),
        endState: mock({ results: [null], expected: [gold] }),
      });
      expect(notCaptured).toMatchObject({ status: "fail", upstreamScore: 0 });
    });

    it("passes the task's own options and rules through (ignore_case, rule getter)", () => {
      const s = setup();
      const gold = s.file("g2.txt", "the RULE");
      const r = (a: string, b: string) =>
        gradeUpstreamTask({
          root: s.root,
          manifest: s.manifest,
          task: s.task("writer-0001"),
          endState: mock({
            results: [s.file("a.txt", a), s.file("b.txt", b)],
            expected: [null, gold],
          }),
        });
      expect(r("a rule here", "The rule")).toMatchObject({ status: "pass", upstreamScore: 1 });
      // conj "and": the first 0.0 stops the evaluation with 0 (DesktopEnv.evaluate).
      expect(r("no word", "the rule")).toMatchObject({ status: "fail", upstreamScore: 0 });
    });

    it("applies upstream's FAIL-action rule: infeasible passes only on FAIL; a normal task fails on FAIL", () => {
      const s = setup();
      const g = (id: string, lastAction: string | null, results: (string | null)[] = []) =>
        gradeUpstreamTask({
          root: s.root,
          manifest: s.manifest,
          task: s.task(id),
          endState: mock({ results, expected: [s.file("g3.txt", "x")], lastAction }),
        });
      expect(g("calc-0002", "FAIL")).toMatchObject({ status: "pass", upstreamScore: 1 });
      expect(g("calc-0002", "DONE")).toMatchObject({ status: "fail", upstreamScore: 0 });
      expect(g("calc-0002", null)).toMatchObject({ status: "fail" });
      expect(g("calc-0001", "FAIL", [s.file("x.txt", "x")])).toMatchObject({
        status: "fail",
        codes: ["AGENT_FAIL_ACTION"],
      });
    });

    it("a partial upstream score is not a pass", () => {
      const s = setup();
      const t = s.task("calc-0001");
      const partial = { ...t, evaluator: { ...t.evaluator, modules: ["text"] } };
      const file = join(s.root, t.taskFile);
      writeFileSync(file, readFileSync(file, "utf8").replace('"same_text"', '"half"'));
      const res = gradeUpstreamTask({
        root: s.root,
        manifest: s.manifest,
        task: { ...partial, taskFileSha256: sha(readFileSync(file)) },
        endState: mock({ results: [s.file("p.txt", "x")], expected: [s.file("q.txt", "x")] }),
      });
      expect(res).toMatchObject({ status: "fail", upstreamScore: 0.5 });
    });

    it("fails closed with codes when a task or evaluator byte moved, a getter is unsupported, or the metric raises", () => {
      const s = setup();
      const base = {
        root: s.root,
        manifest: s.manifest,
        endState: mock({
          results: [s.file("o.txt", "HELLO")],
          expected: [s.file("g.txt", "HELLO")],
        }),
      };
      expect(
        gradeUpstreamTask({
          ...base,
          task: { ...s.task("calc-0001"), taskFileSha256: "0".repeat(64) },
        }),
      ).toMatchObject({
        status: "ungradable",
        codes: ["TASK_FILE_HASH_MISMATCH"],
        upstreamScore: null,
      });
      expect(gradeUpstreamTask({ ...base, task: s.task("impress-0001") })).toMatchObject({
        status: "ungradable",
        codes: ["GETTER_NOT_SUPPORTED:vm_command_line"],
      });
      expect(
        gradeUpstreamTask({ ...base, task: { ...s.task("calc-0001"), taskSetVersion: "other" } }),
      ).toMatchObject({ status: "ungradable", codes: ["TASK_NOT_IN_MANIFEST"] });

      const metric = join(s.root, "desktop_env/evaluators/metrics/text.py");
      const original = readFileSync(metric, "utf8");
      writeFileSync(metric, original.replace("return 1.0 if a == b else 0.0", "return 1.0"));
      expect(gradeUpstreamTask({ ...base, task: s.task("calc-0001") })).toMatchObject({
        status: "ungradable",
        codes: ["EVALUATOR_HASH_MISMATCH"],
      });
      writeFileSync(metric, original);

      const t = s.task("calc-0001");
      const file = join(s.root, t.taskFile);
      writeFileSync(file, readFileSync(file, "utf8").replace('"same_text"', '"boom"'));
      expect(
        gradeUpstreamTask({ ...base, task: { ...t, taskFileSha256: sha(readFileSync(file)) } }),
      ).toMatchObject({ status: "ungradable", codes: ["EVALUATOR_RAISED"] });
    });

    it("never runs the upstream package __init__ files (they raise in the synthetic tree)", () => {
      const s = setup();
      const res = gradeUpstreamTask({
        root: s.root,
        manifest: s.manifest,
        task: s.task("calc-0001"),
        endState: mock({
          results: [s.file("i.txt", "HELLO")],
          expected: [s.file("j.txt", "HELLO")],
        }),
      });
      expect(res.status).toBe("pass");
    });

    it("an interpreter that cannot start is ungradable, never a pass", () => {
      const s = setup();
      const res = gradeUpstreamTask({
        root: s.root,
        manifest: s.manifest,
        task: s.task("calc-0001"),
        endState: mock({
          results: [s.file("k.txt", "HELLO")],
          expected: [s.file("l.txt", "HELLO")],
        }),
        python: "/nonexistent/python3",
      });
      expect(res).toMatchObject({ status: "ungradable", codes: ["EVALUATOR_PROCESS_FAILED"] });
    });

    it("no host environment variable reaches the upstream evaluator process", () => {
      const s = setup();
      const t = s.task("calc-0001");
      const file = join(s.root, t.taskFile);
      writeFileSync(file, readFileSync(file, "utf8").replace('"same_text"', '"env_probe"'));
      process.env.MYCO_UPSTREAM_PROBE_SECRET = "set-by-the-host";
      try {
        const res = gradeUpstreamTask({
          root: s.root,
          manifest: s.manifest,
          task: { ...t, taskFileSha256: sha(readFileSync(file)) },
          endState: mock({ results: [s.file("e.txt", "x")], expected: [s.file("f.txt", "x")] }),
        });
        // The probe metric scores 1.0 only if it can see the host variable.
        expect(res).toMatchObject({ status: "fail", upstreamScore: 0 });
      } finally {
        delete process.env.MYCO_UPSTREAM_PROBE_SECRET;
      }
    });
  },
);
