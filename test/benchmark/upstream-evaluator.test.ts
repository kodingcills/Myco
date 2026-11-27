/**
 * #682 item 3 against the REAL upstream evaluators at the pins. MOCK end states: the gold and
 * result workbooks below are written by this test (the upstream gold files' license is unclear,
 * docs/benchmark/upstream/README.md §1), so these cases prove plumbing only and are never
 * results.
 *
 * Needs pinned checkouts and a Python with scripts/upstream-evaluator-requirements.txt:
 *   MYCO_UPSTREAM_OSWORLD=<checkout> MYCO_UPSTREAM_WAA=<checkout> MYCO_UPSTREAM_PYTHON=<python>
 * Without them the suite skips, unless MYCO_UPSTREAM_REQUIRED=1 (the `upstream evaluators` CI
 * job), where a missing input fails instead.
 *
 * Each case checks Myco's grader against the upstream metric called directly by
 * test/benchmark/upstream_direct_call.py (a separate loading path), and against the expected
 * MOCK label (matching end state -> pass, broken end state -> fail).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { gradeUpstreamTask, type UpstreamEndState } from "../../src/benchmark/upstream/evaluate.ts";
import type { UpstreamManifest, UpstreamTask } from "../../src/benchmark/upstream/import.ts";
import { OSWORLD_PIN, WAA_PIN } from "../../src/benchmark/upstream/pins.ts";

type TestCell = string | number;

const ROOT = resolve(import.meta.dirname, "..", "..");
const OSW = process.env.MYCO_UPSTREAM_OSWORLD;
const WAA = process.env.MYCO_UPSTREAM_WAA;
const PY = process.env.MYCO_UPSTREAM_PYTHON;
const REQUIRED = process.env.MYCO_UPSTREAM_REQUIRED === "1";
const available = Boolean(OSW && WAA && PY);

function load(version: string): { manifest: UpstreamManifest; tasks: UpstreamTask[] } {
  const dir = join(ROOT, "benchmark", "upstream", version);
  return {
    manifest: JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")),
    tasks: readFileSync(join(dir, "tasks.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l)),
  };
}

const work = mkdtempSync(join(tmpdir(), "myco-upstream-mock-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));
let n = 0;
const xlsx = (cells: Record<string, TestCell>) => {
  const p = join(work, `mock-${++n}.xlsx`);
  const spec = join(work, `mock-${n}.json`);
  writeFileSync(spec, JSON.stringify(cells));
  execFileSync(PY as string, ["-I", join(ROOT, "test/benchmark/upstream_mock_xlsx.py"), spec, p], {
    env: { PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8" },
  });
  return p;
};
const s = (v: string): TestCell => v;
const num = (v: number): TestCell => v;

function direct(
  root: string,
  manifest: UpstreamManifest,
  task: UpstreamTask,
  result: string | null,
  expected: string,
) {
  const out = execFileSync(
    PY as string,
    [
      "-I",
      join(ROOT, "test/benchmark/upstream_direct_call.py"),
      root,
      manifest.metricsDir,
      task.taskFile,
      result ?? "-",
      expected,
    ],
    {
      encoding: "utf8",
      env: { PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8" },
      timeout: 120_000,
    },
  );
  return JSON.parse(out.trim().split("\n").pop() as string).score as number;
}

describe("upstream evaluator inputs are present when required", () => {
  it.runIf(REQUIRED)(
    "MYCO_UPSTREAM_REQUIRED=1: checkouts at the pins and the evaluator Python are present",
    () => {
      expect(available).toBe(true);
      const head = (d: string) =>
        execFileSync("git", ["-C", d, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      expect(head(OSW as string)).toBe(OSWORLD_PIN.commit);
      expect(head(WAA as string)).toBe(WAA_PIN.commit);
      expect(spawnSync(PY as string, ["--version"]).status).toBe(0);
    },
  );
});

describe.runIf(available)(
  "real upstream evaluators at the pins, MOCK end states (#682 item 3)",
  () => {
    const osw = load("osworld-office-v1");
    const waa = load("waa-office-v1");
    const find = (set: typeof osw, id: string) => {
      const t = set.tasks.find((x) => x.taskId === id);
      if (!t) throw new Error(id);
      return t;
    };
    const mock = (
      results: (string | null)[],
      expected: (string | null)[],
      lastAction: string | null = null,
    ): UpstreamEndState => ({
      label: "MOCK",
      results,
      expected,
      lastAction,
    });

    /** One compare_table case: Myco's verdict, the direct upstream score, and the MOCK label agree. */
    function tableCase(
      root: string,
      set: typeof osw,
      id: string,
      gold: Record<string, TestCell>,
      result: Record<string, TestCell> | null,
      want: "pass" | "fail",
    ) {
      const task = find(set, id);
      expect(task.evaluator.funcs).toEqual(["compare_table"]);
      const goldPath = xlsx(gold);
      const resultPath = result === null ? null : xlsx(result);
      const v = gradeUpstreamTask({
        root,
        manifest: set.manifest,
        task,
        endState: mock([resultPath], [goldPath]),
        python: PY,
      });
      const ref = direct(root, set.manifest, task, resultPath, goldPath);
      expect(v.label).toBe("MOCK");
      expect(v.upstreamScore).toBe(ref);
      expect(v.status).toBe(ref === 1 ? "pass" : "fail");
      expect(v.status).toBe(want);
    }

    // OSWorld 01b269ae: "Fill all the blank cells in B1:E30 with the value in the cell above it."
    const OSW_ID = "01b269ae-2111-4a07-81fd-3fcd711993b0";
    const filled = {
      A1: s("Student"),
      B1: s("Level"),
      C1: s("Track"),
      A2: s("Ana"),
      B2: s("L1"),
      C2: s("Math"),
      A3: s("Ben"),
      B3: s("L1"),
      C3: s("Math"),
      A4: s("Cy"),
      B4: s("L2"),
      C4: s("Art"),
    };

    it("OSWorld calc compare_table: a MOCK end state equal to the MOCK gold passes, as upstream says", () => {
      tableCase(OSW as string, osw, OSW_ID, filled, { ...filled }, "pass");
    });

    it("OSWorld calc compare_table: a deliberately failed MOCK end state (one blank left) fails, as upstream says", () => {
      const { B3: _b3, ...withBlank } = filled;
      tableCase(OSW as string, osw, OSW_ID, filled, withBlank, "fail");
    });

    it("OSWorld calc compare_table: an uncaptured result file fails, as upstream says", () => {
      tableCase(OSW as string, osw, OSW_ID, filled, null, "fail");
    });

    // WAA 0bf05a7d: pad 'Old ID' to seven digits in 'New 7 Digit ID'.
    const WAA_ID = "0bf05a7d-b28b-44d2-955a-50b41e24012a-WOS";
    const padded = {
      A1: s("Old ID"),
      B1: s("New 7 Digit ID"),
      A2: num(123),
      B2: s("0000123"),
      A3: num(45678),
      B3: s("0045678"),
    };

    it("WAA calc compare_table: matching MOCK end state passes, as upstream says", () => {
      tableCase(WAA as string, waa, WAA_ID, padded, { ...padded }, "pass");
    });

    it("WAA calc compare_table: a deliberately failed MOCK end state (wrong digit) fails, as upstream says", () => {
      tableCase(WAA as string, waa, WAA_ID, padded, { ...padded, B3: s("0045679") }, "fail");
    });

    it("upstream leniency, mirrored not corrected: WAA compare_table accepts an UNPADDED id for this padding task", () => {
      // pandas.read_excel (upstream _load_sheet) infers "0045678" and "45678" as the same number,
      // so the upstream evaluator passes an end state that skipped the task's whole point. Myco
      // reports exactly the upstream verdict; the leniency is a finding for #671/#675, not a fix.
      tableCase(WAA as string, waa, WAA_ID, padded, { ...padded, B3: s("45678") }, "pass");
    });

    it("OSWorld infeasible task: the agent saying DONE fails and FAIL passes (upstream DesktopEnv.evaluate rule)", () => {
      const task = find(osw, "2bd59342-0664-4ccb-ba87-79379096cc08");
      expect(task.evaluator.funcs).toEqual(["infeasible"]);
      const g = (lastAction: string) =>
        gradeUpstreamTask({
          root: OSW as string,
          manifest: osw.manifest,
          task,
          endState: mock([], [], lastAction),
          python: PY,
        });
      expect(g("DONE")).toMatchObject({ status: "fail", upstreamScore: 0, label: "MOCK" });
      expect(g("FAIL")).toMatchObject({ status: "pass", upstreamScore: 1, label: "MOCK" });
    });

    it("WAA notepad: a getter Myco cannot stand in for yet is ungradable, never a pass", () => {
      const task = find(waa, "366de66e-cbae-4d72-b042-26390db2b145-WOS");
      const v = gradeUpstreamTask({
        root: WAA as string,
        manifest: waa.manifest,
        task,
        endState: mock([null, null], [null, null]),
        python: PY,
      });
      expect(v).toMatchObject({
        status: "ungradable",
        codes: ["GETTER_NOT_SUPPORTED:vm_file_exists_in_vm_folder"],
      });
    });

    it("every task file and evaluator file in both manifests matches the pinned checkout byte for byte, and instructions are verbatim", () => {
      const h = (b: Buffer) => createHash("sha256").update(b).digest("hex");
      for (const [root, set] of [
        [OSW as string, osw],
        [WAA as string, waa],
      ] as const) {
        for (const [f, digest] of Object.entries(set.manifest.evaluatorFiles))
          expect(h(readFileSync(join(root, f))), f).toBe(digest);
        for (const t of set.tasks) {
          const raw = readFileSync(join(root, t.taskFile));
          expect(h(raw), t.taskFile).toBe(t.taskFileSha256);
          expect(JSON.parse(raw.toString("utf8")).instruction).toBe(t.instruction);
        }
      }
    });
  },
);
